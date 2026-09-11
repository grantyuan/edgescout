// ---------------------------------------------------------------------------
// EdgeScout — paper-trading ledger (simulated fills, no chain orders)
//
// Persists to <cwd>/data/paper-ledger.json so the demo survives restarts.
// Settlement is price-based: once a market's window has expired we resolve the
// outcome from spot vs. the settlement reference (strike for strike markets,
// the window open price for up/down markets) — the same rule the deterministic
// model uses at expiry. The testnet indexer leaves markets in `Trading`
// status indefinitely, so we cannot rely on on-chain `winningOutcome`.
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import path from "node:path";
import { PAPER } from "./config.ts";
import { type MarketView } from "./market.ts";

export type Side = "YES" | "NO";

export interface LedgerEntry {
  id: string;
  symbol: string;
  asset: string;
  side: Side;
  /** 1/4-Kelly stake as fraction of bankroll at entry (0..maxPositionPct). */
  stakePct: number;
  /** Stake in tUSDC. */
  stake: number;
  /** YES-side shares purchased (side NO is priced as (1 - entryPrice)). */
  shares: number;
  /** Effective entry price on the side held (0..1). */
  entryPrice: number;
  openAt: number;
  /** Market expiry (ms). */
  expiresAtMs: number;
  /**
   * Settlement reference price captured at entry: strike for strike markets,
   * window open (or EMA fallback) for up/down markets. Lets a position settle
   * by spot comparison even after the market leaves the live indexer list.
   */
  refPrice: number | null;
  refKind: "strike" | "open" | "ema" | null;
  status: "open" | "settled";
  /** Unix ms when settled (auto-settled at expiry). */
  closeAt: number | null;
  /** true if the held side won. */
  win: boolean | null;
  /** Settled PnL in tUSDC (positive = profit). */
  pnl: number | null;
  /**
   * Optional KeeperHub on-chain execution for this paper position (testnet
   * USDC transfer on Base Sepolia). Null until the dashboard's
   * "Execute on-chain via KeeperHub" button runs.
   */
  keeperhub?: import("./keeperhub.ts").KeeperhubExecution | null;
}

export interface PaperAccount {
  startingBalance: number;
  balance: number;
  totalPnl: number;
  wins: number;
  losses: number;
  winRate: number | null;
  open: PaperPosition[];
  settled: LedgerEntry[];
}

export interface PaperPosition {
  entry: LedgerEntry;
  /** Latest market snapshot (null when the market is gone / expired+settled). */
  view: MarketView | null;
  /** Mark value of the held position in tUSDC. */
  markValue: number;
  /** Unrealized PnL in tUSDC. */
  unrealizedPnl: number;
}

const DATA_DIR = path.join(process.cwd(), "data");
const LEDGER_FILE = path.join(DATA_DIR, "paper-ledger.json");

interface LedgerFile {
  entries: LedgerEntry[];
}

/**
 * Fallback for read-only / ephemeral filesystems (e.g. Vercel serverless):
 * once a file save fails, the ledger lives in process memory for the rest of
 * the instance and saveLedger becomes a memory write. Local dev still persists
 * to data/paper-ledger.json across restarts.
 */
let memoryFallback: LedgerFile | null = null;

// Simple async mutex: serialize all ledger writes behind one promise chain.
let mutex: Promise<void> = Promise.resolve();

function lock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(() => fn());
  mutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function loadLedger(): Promise<LedgerFile> {
  if (memoryFallback) return memoryFallback;
  try {
    const raw = await fs.readFile(LEDGER_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<LedgerFile>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    // no ledger yet, or file unreadable → empty
    return { entries: [] };
  }
}

async function saveLedger(file: LedgerFile): Promise<void> {
  if (memoryFallback) {
    memoryFallback = file;
    return;
  }
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(LEDGER_FILE, JSON.stringify(file, null, 2), "utf8");
  } catch {
    // read-only / ephemeral filesystem → degrade to in-memory ledger
    memoryFallback = file;
  }
}

/**
 * Determine the YES outcome from a live snapshot:
 * strike markets settle when spot >= strike; up/down markets settle when
 * spot >= window open (falls back to EMA when the open couldn't be fetched).
 */
export function yesOutcome(view: MarketView): boolean | null {
  const spot = view.spot;
  if (spot == null || !(spot > 0)) return null;
  const ref = view.upDown ? (view.openPrice ?? view.ema) : view.strike;
  if (ref == null || !(ref > 0)) return null;
  return spot >= ref;
}

/** Spot-price source for the settlement fallback (injectable for tests). */
export type SpotProvider = (asset: string) => Promise<number | null>;

/** Default spot provider: live testnet price via the markets SDK. */
const defaultSpotProvider: SpotProvider = async (asset: string) => {
  try {
    const { fetchAssetPrice } = await import("./market.ts");
    return (await fetchAssetPrice(asset)).spot ?? null;
  } catch {
    return null;
  }
};

/**
 * Settle every open entry whose market window has expired.
 * Primary path: live market snapshot (spot vs strike / window open).
 * Fallback path: the market already left the live indexer list → settle by
 * comparing current asset spot against the ref price captured at entry.
 * Entries without any usable reference are left open.
 */
export async function settleDue(
  entries: LedgerEntry[],
  views: Map<string, MarketView | null>,
  spotProvider: SpotProvider = defaultSpotProvider,
): Promise<LedgerFile> {
  const file: LedgerFile = { entries };
  let changed = false;
  const spotCache = new Map<string, number | null>();

  const spotFor = async (asset: string): Promise<number | null> => {
    if (spotCache.has(asset)) return spotCache.get(asset) ?? null;
    const spot = await spotProvider(asset);
    spotCache.set(asset, spot ?? null);
    return spot ?? null;
  };

  for (const e of file.entries) {
    if (e.status !== "open" || Date.now() < e.expiresAtMs) continue;
    const view = views.get(e.symbol) ?? null;
    let yesWin = view ? yesOutcome(view) : null;
    if (yesWin == null && e.refPrice != null && e.refPrice > 0) {
      const spot = await spotFor(e.asset);
      if (spot != null && spot > 0) yesWin = spot >= e.refPrice;
    }
    if (yesWin == null) continue;
    e.status = "settled";
    e.closeAt = Date.now();
    e.win = e.side === "YES" ? yesWin : !yesWin;
    // Binary payoff: winner gets 1.0 per share, loser 0.
    const payoff = e.win ? e.shares : 0;
    e.pnl = Math.round((payoff - e.stake) * 1e6) / 1e6;
    changed = true;
  }
  if (changed) await saveLedger(file);
  return file;
}

/** Build the account summary, marking open positions with the latest views. */
export async function getAccount(): Promise<PaperAccount> {
  const file = await loadLedger();
  const openEntries = file.entries.filter((e) => e.status === "open");

  // Fetch live views for all open positions in one pass (dedup by symbol).
  const views = new Map<string, MarketView | null>();
  if (openEntries.length > 0) {
    try {
      const { fetchBoard, buildViewForSymbol } = await import("./market.ts");
      const board = await fetchBoard();
      for (const v of board) views.set(v.symbol, v);
      for (const e of openEntries) {
        if (!views.has(e.symbol)) {
          try {
            views.set(e.symbol, await buildViewForSymbol(e.symbol));
          } catch {
            views.set(e.symbol, null);
          }
        }
      }
      await settleDue(file.entries, views);
    } catch {
      // Data layer down: report open positions unmarked.
      for (const e of openEntries) if (!views.has(e.symbol)) views.set(e.symbol, null);
    }
  }

  const balance = PAPER.startingBalance + file.entries
    .filter((e) => e.status === "settled")
    .reduce((s, e) => s + (e.pnl ?? 0), 0);

  // Build the open list AFTER the settlement pass so entries settled during
  // this request do not leak into both lists.
  const open: PaperPosition[] = file.entries
    .filter((e) => e.status === "open")
    .map((entry) => {
      const view = views.get(entry.symbol) ?? null;
      let mark = entry.entryPrice;
      if (view) {
        const pYes = view.pImplied ?? view.model.pModel;
        mark = entry.side === "YES" ? pYes : 1 - pYes;
      }
      const markValue = Math.round(entry.shares * mark * 1e6) / 1e6;
      return {
        entry,
        view,
        markValue,
        unrealizedPnl: Math.round((markValue - entry.stake) * 1e6) / 1e6,
      };
    });

  const settled = file.entries
    .filter((e) => e.status === "settled")
    .slice()
    .reverse();
  const wins = settled.filter((e) => e.win === true).length;
  const losses = settled.filter((e) => e.win === false).length;

  return {
    startingBalance: PAPER.startingBalance,
    balance: Math.round(balance * 1e6) / 1e6,
    totalPnl: Math.round(
      settled.reduce((s, e) => s + (e.pnl ?? 0), 0) * 1e6,
    ) / 1e6,
    wins,
    losses,
    winRate:
      settled.length > 0
        ? Math.round((wins / settled.length) * 100) / 100
        : null,
    open,
    settled,
  };
}

/**
 * Open a simulated position for a live market using the deterministic sizing
 * module (1/4 Kelly, capped). Returns the new account summary.
 */
export async function openPosition(view: MarketView): Promise<PaperAccount> {
  return lock(async () => {
    const file = await loadLedger();
    const settled = file.entries.filter((e) => e.status === "settled");
    const balance =
      PAPER.startingBalance +
      settled.reduce((s, e) => s + (e.pnl ?? 0), 0);
    const sug = view.suggestion;
    if (!sug || sug.action === "SKIP" || !(sug.entryPrice > 0 && sug.entryPrice < 1)) {
      throw new Error("no executable suggestion for this market");
    }
    const stakePct = Math.min(sug.positionPct, PAPER.maxPositionPct);
    const stake = Math.min(
      Math.round(stakePct * balance * 1e6) / 1e6,
      Math.round(balance * 1e6) / 1e6,
    );
    if (!(stake > 0)) throw new Error("insufficient paper balance");
    const side: Side = sug.action === "BUY_YES" ? "YES" : "NO";
    // NO is bought at (1 - yesAsk) so it can be marked consistently.
    const entryPrice =
      side === "YES" ? sug.entryPrice : 1 - (view.book.yesBid ?? sug.entryPrice);
    // Capture the settlement reference at entry so the position can still be
    // settled after the market disappears from the live indexer list.
    const refPrice = view.upDown ? (view.openPrice ?? view.ema) : view.strike;
    const refKind: LedgerEntry["refKind"] = view.upDown
      ? view.openPrice != null
        ? "open"
        : "ema"
      : "strike";
    const entry: LedgerEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: view.symbol,
      asset: view.asset,
      side,
      stakePct,
      stake,
      shares: Math.round((stake / entryPrice) * 1e6) / 1e6,
      entryPrice: Math.round(entryPrice * 1e6) / 1e6,
      openAt: Date.now(),
      expiresAtMs: Date.parse(view.expiresAt),
      refPrice: refPrice != null && refPrice > 0 ? refPrice : null,
      refKind,
      status: "open",
      closeAt: null,
      win: null,
      pnl: null,
    };
    file.entries.push(entry);
    await saveLedger(file);
    return getAccount();
  });
}

/**
 * Attach a KeeperHub on-chain execution to an open paper ledger entry and
 * persist it. This is how the dashboard's "Execute on-chain via KeeperHub"
 * flow writes the transaction link back into the ledger. Returns the
 * updated entry, or null when the entry does not exist / is not open.
 */
export async function attachKeeperhubExecution(
  entryId: string,
  execution: import("./keeperhub.ts").KeeperhubExecution,
): Promise<LedgerEntry | null> {
  return lock(async () => {
    const file = await loadLedger();
    const entry = file.entries.find((e) => e.id === entryId);
    if (!entry || entry.status !== "open") return null;
    entry.keeperhub = execution;
    await saveLedger(file);
    return entry;
  });
}

// ---------------------------------------------------------------------------
// CSV export (deterministic serializer for GET /api/paper/export)
//
// The persisted ledger (settled + open entries) is serialized to RFC 4180 CSV:
// fixed column order, LF line endings, rows sorted by openAt asc then id asc
// (stable across file edits), null/undefined → empty string, numbers as-is,
// booleans as true/false, timestamps emitted both as unix-ms and UTC ISO-8601,
// and string fields quoted only when they contain , " CR or LF (embedded
// quotes doubled). The export is a snapshot: settlement runs on /api/paper
// reads, never on export.
// ---------------------------------------------------------------------------

/** Stable CSV column order for the paper-ledger export (part of the API). */
export const PAPER_CSV_COLUMNS = [
  "id",
  "symbol",
  "asset",
  "side",
  "status",
  "stake_pct",
  "stake",
  "shares",
  "entry_price",
  "open_at_ms",
  "open_at_iso",
  "expires_at_ms",
  "close_at_ms",
  "close_at_iso",
  "win",
  "pnl",
  "ref_price",
  "ref_kind",
  "keeperhub_status",
  "keeperhub_tx_hash",
  "keeperhub_tx_link",
] as const;

/** Serialize one value: null/undefined → "", numbers as-is, booleans as words. */
function csvField(
  value: string | number | boolean | null | undefined,
): string {
  if (value == null) return "";
  let s: string;
  if (typeof value === "number") {
    s = Number.isFinite(value) ? String(value) : "";
  } else if (typeof value === "boolean") {
    s = value ? "true" : "false";
  } else {
    s = value;
  }
  // RFC 4180: quote when the field contains a comma, quote, CR or LF;
  // double any embedded quotes.
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Unix ms → UTC ISO-8601 (null/undefined → empty cell), deterministic. */
function isoMs(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

/**
 * Serialize ledger entries to CSV (deterministic). Defensive against
 * malformed rows (entries without a non-empty string id are dropped) so a
 * corrupted ledger file can never throw out of the serializer.
 */
export function entriesToCsv(entries: LedgerEntry[]): string {
  const rows: string[][] = [Array.from(PAPER_CSV_COLUMNS)];
  const safe = Array.isArray(entries) ? entries : [];
  const sorted = safe
    .filter(
      (e): e is LedgerEntry =>
        !!e && typeof e === "object" &&
        typeof (e as LedgerEntry).id === "string" &&
        ((e as LedgerEntry).id ?? "").length > 0,
    )
    .slice()
    .sort((a, b) => {
      const ka =
        typeof a.openAt === "number" && Number.isFinite(a.openAt)
          ? a.openAt
          : 0;
      const kb =
        typeof b.openAt === "number" && Number.isFinite(b.openAt)
          ? b.openAt
          : 0;
      if (ka !== kb) return ka - kb;
      const ia = String(a.id ?? "");
      const ib = String(b.id ?? "");
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
  for (const e of sorted) {
    const kh = e.keeperhub ?? null;
    rows.push(
      [
        e.id,
        e.symbol,
        e.asset,
        e.side,
        e.status,
        e.stakePct,
        e.stake,
        e.shares,
        e.entryPrice,
        e.openAt,
        isoMs(e.openAt),
        e.expiresAtMs,
        e.closeAt,
        isoMs(e.closeAt),
        e.win,
        e.pnl,
        e.refPrice,
        e.refKind,
        kh ? kh.status : null,
        kh ? kh.txHash : null,
        kh ? kh.txLink : null,
      ].map((v) => csvField(v)),
    );
  }
  return rows.map((r) => r.join(",")).join("\n") + "\n";
}
