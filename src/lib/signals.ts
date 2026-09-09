// ---------------------------------------------------------------------------
// EdgeScout — signal / edge observation log
//
// Records what the DETERMINISTIC model observes on every board refresh:
// pModel (fair value), pImplied (book mid) and their difference (edge) per
// market. This turns "tradeable edge" from a claim into a *measurement*:
// how often |edge| >= 3pp appears, how large it is, and how long it persists
// (rows are sampled per market over time).
//
// Design constraints (mirror the paper ledger):
//   * read-only observation — the log never influences the board/model;
//   * fire-and-forget from fetchBoard — recording must never block or break
//     the live wall;
//   * sampled at most once per market per SIGNAL_SAMPLE_INTERVAL_MS so a
//     15s dashboard poll does not flood the file;
//   * ring buffer capped at MAX_SIGNAL_ROWS (oldest rows drop off);
//   * persists to <cwd>/data/signal-history.json; on a read-only/ephemeral
//     filesystem it degrades to in-memory (same pattern as paper.ts).
// summarizeSignals is a pure, unit-tested core — the UI/API round it.
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import path from "node:path";
import { EDGE_THRESHOLD } from "./model.ts";
import type { MarketView } from "./market.ts";

/** One sampled model-vs-book observation for one market. */
export interface SignalObservation {
  /** Unix ms when the sample was taken. */
  atMs: number;
  /** Canonical market symbol (same as the board). */
  symbol: string;
  /** Underlying asset code ("BTC" / "ETH"). */
  asset: string;
  /** True for up/down (strike-0) markets. */
  upDown: boolean;
  /** Seconds until expiry at sample time. */
  secondsToExpiry: number;
  /** Deterministic model P(YES), 0..1. */
  pModel: number;
  /** Book mid (implied P(YES)); null when the book is one-sided/empty. */
  pImplied: number | null;
  /** pModel - pImplied; null when pImplied is null. */
  edge: number | null;
  /** classifyEdge label; "n/a" when no book. */
  edgeKind: "aligned" | "yes-underpriced" | "yes-overpriced" | "n/a";
  /** Spot at sample time (null when the price feed had no data). */
  spot: number | null;
}

/** One of the largest-|edge| observations retained in the window. */
export interface SignalTopEdge {
  symbol: string;
  asset: string;
  edge: number;
  edgeKind: SignalObservation["edgeKind"];
  atMs: number;
}

/** Aggregated view of the retained observation window (all JSON-safe). */
export interface SignalSummary {
  /** Observations in the retained ring buffer. */
  total: number;
  /** Distinct markets observed. */
  markets: number;
  /** Earliest retained sample (unix ms); null when empty. */
  periodStartMs: number | null;
  /** Latest retained sample (unix ms); null when empty. */
  periodEndMs: number | null;
  /** Rows with a live two-sided book (edge != null). */
  withBook: number;
  /** Rows where |edge| >= EDGE_THRESHOLD (the tradeable band, 3pp). */
  edgeGe3pp: number;
  /** edgeGe3pp / withBook (0..1); null when no rows have a book. */
  edgeRate: number | null;
  /** Mean |edge| over book rows; null when none. */
  meanAbsEdge: number | null;
  /** Max |edge| over book rows; null when none. */
  maxAbsEdge: number | null;
  /** Symbol of the largest-|edge| observation; null when none. */
  maxAbsEdgeSymbol: string | null;
  /**
   * Five largest-|edge| observations in the retained window, |edge| desc,
   * ties broken by newest first then symbol asc (deterministic). Rows with a
   * null/non-finite edge are excluded.
   */
  topEdges: SignalTopEdge[];
  /** kindCounts over ALL rows (noBook = rows without a two-sided book). */
  kindCounts: {
    aligned: number;
    yesUnderpriced: number;
    yesOverpriced: number;
    noBook: number;
  };
  /** Most recent observations, newest first (capped at 20). */
  recent: SignalObservation[];
}

/** Sampling gate: one row per market per this interval (ms). */
export const SIGNAL_SAMPLE_INTERVAL_MS = 60_000;
/** Ring-buffer cap on retained observations. */
export const MAX_SIGNAL_ROWS = 2000;
/** How many rows the summary surfaces as "recent". */
const RECENT_LIMIT = 20;
/** How many largest-|edge| rows the summary surfaces. */
const TOP_EDGES_LIMIT = 5;
/** lastAtMs housekeeping: forget gates older than this (ms). */
const GATE_TTL_MS = 24 * 3600 * 1000;

const DATA_DIR = path.join(process.cwd(), "data");
const SIGNAL_FILE = path.join(DATA_DIR, "signal-history.json");

/** On-disk shape (versioned so future formats can be rejected cleanly). */
interface SignalFile {
  version: 1;
  observations: SignalObservation[];
  /** symbol → last sampled atMs (the sampling gate survives restarts). */
  lastAtMs: Record<string, number>;
}

/** Fresh empty log (never a shared reference — callers mutate observations/lastAtMs). */
function emptyFile(): SignalFile {
  return { version: 1, observations: [], lastAtMs: {} };
}

/**
 * Fallback for read-only / ephemeral filesystems (e.g. Vercel serverless):
 * once a save fails the log lives in process memory for the instance, same
 * as the paper ledger. Local/self-hosted keeps it across restarts.
 */
let memoryFallback: SignalFile | null = null;

async function saveFile(file: SignalFile): Promise<void> {
  if (memoryFallback) {
    memoryFallback = file;
    return;
  }
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(SIGNAL_FILE, JSON.stringify(file), "utf8");
  } catch {
    memoryFallback = file;
  }
}

/**
 * Load the retained observations. Never throws: a missing, unreadable or
 * malformed file (including a wrong version) degrades to an empty log so a
 * bad file can never break the dashboard.
 */
export async function loadSignals(): Promise<SignalFile> {
  if (memoryFallback) return memoryFallback;
  try {
    const raw = await fs.readFile(SIGNAL_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SignalFile>;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.observations)
    ) {
      return emptyFile();
    }
    const lastAtMs =
      parsed.lastAtMs && typeof parsed.lastAtMs === "object" && !Array.isArray(parsed.lastAtMs)
        ? (parsed.lastAtMs as Record<string, number>)
        : {};
    return { version: 1, observations: parsed.observations, lastAtMs };
  } catch {
    return emptyFile();
  }
}

/** Map one board view to a sample (pure; used by recordBoard and tests). */
export function toObservation(view: MarketView, atMs: number): SignalObservation {
  return {
    atMs,
    symbol: view.symbol,
    asset: view.asset,
    upDown: view.upDown,
    secondsToExpiry: view.secondsToExpiry,
    pModel: view.model.pModel,
    pImplied: view.pImplied,
    edge: view.edge,
    edgeKind: view.edgeKind,
    spot: view.spot,
  };
}

/**
 * Append at most one sample per market per SIGNAL_SAMPLE_INTERVAL_MS.
 * Returns the number of rows actually recorded (0 when every market is
 * still inside its gate). `nowMs` is injectable for deterministic tests.
 */
export async function recordBoard(
  views: MarketView[],
  nowMs: number = Date.now(),
): Promise<number> {
  const file = await loadSignals();
  let recorded = 0;
  for (const view of views) {
    const last = file.lastAtMs[view.symbol] ?? 0;
    if (nowMs - last < SIGNAL_SAMPLE_INTERVAL_MS) continue;
    file.observations.push(toObservation(view, nowMs));
    file.lastAtMs[view.symbol] = nowMs;
    recorded++;
  }
  if (recorded === 0) return 0;
  // Ring buffer: keep only the newest MAX_SIGNAL_ROWS observations.
  if (file.observations.length > MAX_SIGNAL_ROWS) {
    file.observations = file.observations.slice(file.observations.length - MAX_SIGNAL_ROWS);
  }
  // Housekeeping: forget gates whose market has been gone for > 24h.
  for (const sym of Object.keys(file.lastAtMs)) {
    if (nowMs - file.lastAtMs[sym] > GATE_TTL_MS) delete file.lastAtMs[sym];
  }
  await saveFile(file);
  return recorded;
}

/**
 * Pure aggregation core (unit-tested): edge frequency / size / persistence
 * stats over the retained rows. Full precision — rounding happens in the UI.
 * Input order is assumed chronological (append-only ring); `recent` sorts a
 * copy defensively so malformed legacy files cannot crash the summary.
 */
export function summarizeSignals(rows: SignalObservation[]): SignalSummary {
  const total = rows.length;
  if (total === 0) {
    return {
      total: 0,
      markets: 0,
      periodStartMs: null,
      periodEndMs: null,
      withBook: 0,
      edgeGe3pp: 0,
      edgeRate: null,
      meanAbsEdge: null,
      maxAbsEdge: null,
      maxAbsEdgeSymbol: null,
      kindCounts: { aligned: 0, yesUnderpriced: 0, yesOverpriced: 0, noBook: 0 },
      topEdges: [],
      recent: [],
    };
  }

  const symbols = new Set<string>();
  let periodStartMs = Infinity;
  let periodEndMs = -Infinity;
  let withBook = 0;
  let edgeGe3pp = 0;
  let absEdgeSum = 0;
  let maxAbsEdge: number | null = null;
  let maxAbsEdgeSymbol: string | null = null;
  const kindCounts: SignalSummary["kindCounts"] = {
    aligned: 0,
    yesUnderpriced: 0,
    yesOverpriced: 0,
    noBook: 0,
  };

  for (const r of rows) {
    if (typeof r.atMs !== "number" || !Number.isFinite(r.atMs)) continue;
    symbols.add(r.symbol);
    if (r.atMs < periodStartMs) periodStartMs = r.atMs;
    if (r.atMs > periodEndMs) periodEndMs = r.atMs;
    const edge =
      typeof r.edge === "number" && Number.isFinite(r.edge) ? r.edge : null;
    if (edge == null) {
      kindCounts.noBook += 1;
    } else {
      withBook += 1;
      if (Math.abs(edge) >= EDGE_THRESHOLD) edgeGe3pp += 1;
      const a = Math.abs(edge);
      absEdgeSum += a;
      if (maxAbsEdge == null || a > maxAbsEdge) {
        maxAbsEdge = a;
        maxAbsEdgeSymbol = r.symbol;
      }
      if (r.edgeKind === "yes-underpriced") kindCounts.yesUnderpriced += 1;
      else if (r.edgeKind === "yes-overpriced") kindCounts.yesOverpriced += 1;
      else kindCounts.aligned += 1;
    }
  }

  const recent = rows
    .slice()
    .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))
    .slice(-RECENT_LIMIT)
    .reverse();

  // Top-5 largest-|edge| observations across the WHOLE retained window (not
  // just the recent tail). Excludes rows without a usable edge; ordering is
  // deterministic: |edge| desc, then newest first, then symbol asc.
  const topEdges: SignalTopEdge[] = rows
    .filter(
      (r) =>
        typeof r.atMs === "number" &&
        Number.isFinite(r.atMs) &&
        typeof r.edge === "number" &&
        Number.isFinite(r.edge),
    )
    .map((r) => ({
      symbol: r.symbol,
      asset: r.asset,
      edge: r.edge as number,
      edgeKind: r.edgeKind,
      atMs: r.atMs as number,
    }))
    .sort(
      (a, b) =>
        Math.abs(b.edge) - Math.abs(a.edge) ||
        b.atMs - a.atMs ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, TOP_EDGES_LIMIT);

  return {
    total,
    markets: symbols.size,
    periodStartMs: Number.isFinite(periodStartMs) ? periodStartMs : null,
    periodEndMs: Number.isFinite(periodEndMs) ? periodEndMs : null,
    withBook,
    edgeGe3pp,
    edgeRate: withBook > 0 ? edgeGe3pp / withBook : null,
    meanAbsEdge: withBook > 0 ? absEdgeSum / withBook : null,
    maxAbsEdge,
    maxAbsEdgeSymbol,
    topEdges,
    kindCounts,
    recent,
  };
}
