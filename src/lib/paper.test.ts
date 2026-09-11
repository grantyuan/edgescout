// ---------------------------------------------------------------------------
// EdgeScout — paper-ledger settlement tests (node:test, no framework).
// Run: npm test
//
// The ledger file lives under process.cwd()/data — chdir to a temp dir
// BEFORE loading paper.ts so its module-level DATA_DIR points at the
// sandbox and no real demo ledger is ever touched.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "edgescout-paper-test-"));
process.chdir(tmpRoot);

const paper = await import("./paper.ts");
const { settleDue, yesOutcome, PAPER_CSV_COLUMNS } = paper;
const COLS = [...PAPER_CSV_COLUMNS];
import type { LedgerEntry } from "./paper.ts";
import type { MarketView, BookTop } from "./market.ts";

const SYM = "BTC-8000000-31AUG26-1200/tUSDC";

function mkView(over: Partial<MarketView> = {}): MarketView {
  const book: BookTop = {
    yesBid: 0.5,
    yesAsk: 0.55,
    depth: 200,
    timestamp: null,
    bids: [[0.5, 100]],
    asks: [[0.55, 100]],
  };
  return {
    symbol: SYM,
    asset: "BTC",
    strike: 80000,
    strikeLabel: "80000",
    upDown: false,
    expiresAt: new Date(1).toISOString(),
    secondsToExpiry: 0,
    active: true,
    book,
    pImplied: 0.525,
    model: {
      pModel: 0.5,
      dSigma: 0,
      secondsToExpiry: 0,
      volAnnualized: 0.5,
      volSource: "default",
    },
    edge: 0,
    edgeKind: "n/a",
    risk: 50,
    suggestion: null,
    openPrice: null,
    question: null,
    spot: 81000,
    ema: null,
    ...over,
  };
}

function mkEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "test-entry",
    symbol: SYM,
    asset: "BTC",
    side: "YES",
    stakePct: 0.1,
    stake: 1000,
    shares: 2000,
    entryPrice: 0.5,
    openAt: 0,
    expiresAtMs: 1, // expired unless overridden
    refPrice: 80000,
    refKind: "strike",
    status: "open",
    closeAt: null,
    win: null,
    pnl: null,
    ...over,
  };
}

// --- yesOutcome ---------------------------------------------------------------

test("yesOutcome: strike market settles by spot vs strike", () => {
  assert.equal(
    yesOutcome(mkView({ strike: 80000, upDown: false, spot: 81000 })),
    true,
  );
  assert.equal(
    yesOutcome(mkView({ strike: 80000, upDown: false, spot: 79999 })),
    false,
  );
  assert.equal(
    yesOutcome(mkView({ strike: 80000, upDown: false, spot: 80000 })),
    true, // "at or above" — boundary inclusive
  );
});

test("yesOutcome: up/down settles by window open, EMA fallback", () => {
  assert.equal(
    yesOutcome(mkView({ upDown: true, openPrice: 80000, spot: 80001 })),
    true,
  );
  assert.equal(
    yesOutcome(mkView({ upDown: true, openPrice: 80000, spot: 79999 })),
    false,
  );
  assert.equal(
    yesOutcome(mkView({ upDown: true, openPrice: null, ema: 80000, spot: 79999 })),
    false,
  );
});

test("yesOutcome: missing ref or spot → null", () => {
  assert.equal(
    yesOutcome(mkView({ upDown: true, openPrice: null, ema: null, spot: 81000 })),
    null,
  );
  assert.equal(
    yesOutcome(mkView({ strike: 80000, upDown: false, spot: null })),
    null,
  );
});

// --- settleDue: view path -------------------------------------------------------

test("settleDue: YES winner pays shares, pnl = shares - stake", async () => {
  const entries = [mkEntry({ side: "YES", stake: 1000, shares: 2000 })];
  const views = new Map<string, MarketView | null>([
    [SYM, mkView({ spot: 90000, strike: 80000, upDown: false })],
  ]);
  const out = await settleDue(entries, views, async () => null);
  const e = out.entries[0];
  assert.equal(e.status, "settled");
  assert.equal(e.win, true);
  assert.equal(e.pnl, 1000); // 2000 shares × 1.0 − 1000 stake
});

test("settleDue: NO side wins when spot < ref, loser pnl = -stake", async () => {
  const entries = [mkEntry({ side: "NO", stake: 1000, shares: 2000 })];
  const views = new Map<string, MarketView | null>([
    [SYM, mkView({ spot: 70000, strike: 80000, upDown: false })],
  ]);
  const out = await settleDue(entries, views, async () => null);
  const e = out.entries[0];
  assert.equal(e.status, "settled");
  assert.equal(e.win, true);
  assert.equal(e.pnl, 1000);

  // mirror: NO loses when spot > ref
  const lose = [mkEntry({ side: "NO", stake: 1000, shares: 2000 })];
  const viewsL = new Map<string, MarketView | null>([
    [SYM, mkView({ spot: 90000, strike: 80000, upDown: false })],
  ]);
  const outL = await settleDue(lose, viewsL, async () => null);
  assert.equal(outL.entries[0].win, false);
  assert.equal(outL.entries[0].pnl, -1000);
});

test("settleDue: not-yet-expired entries are untouched", async () => {
  const entries = [
    mkEntry({ expiresAtMs: Date.now() + 3_600_000, status: "open" }),
  ];
  const views = new Map<string, MarketView | null>([
    [SYM, mkView({ spot: 90000 })],
  ]);
  const out = await settleDue(entries, views, async () => null);
  assert.equal(out.entries[0].status, "open");
  assert.equal(out.entries[0].pnl, null);
});

test("settleDue: settled entries are not settled twice", async () => {
  const entries = [
    mkEntry({ status: "settled", win: true, pnl: 500, closeAt: 1 }),
  ];
  const views = new Map<string, MarketView | null>([[SYM, null]]);
  const out = await settleDue(entries, views, async () => null);
  assert.equal(out.entries[0].pnl, 500);
});

// --- settleDue: ref-price fallback (market left the live list) -------------------

test("settleDue: gone market settles via captured refPrice + spot", async () => {
  const entries = [
    mkEntry({ side: "YES", refPrice: 80000, refKind: "strike" }),
  ];
  const views = new Map<string, MarketView | null>([[SYM, null]]);
  const out = await settleDue(entries, views, async (asset) => {
    assert.equal(asset, "BTC");
    return 81000;
  });
  const e = out.entries[0];
  assert.equal(e.status, "settled");
  assert.equal(e.win, true);
  assert.equal(e.pnl, 1000);
});

test("settleDue: NO side settles via refPrice fallback when spot < ref", async () => {
  const entries = [mkEntry({ side: "NO", refPrice: 80000, refKind: "strike" })];
  const views = new Map<string, MarketView | null>([[SYM, null]]);
  const out = await settleDue(entries, views, async () => 79000);
  assert.equal(out.entries[0].status, "settled");
  assert.equal(out.entries[0].win, true);
});

test("settleDue: provider failure keeps entry open", async () => {
  const entries = [mkEntry({ refPrice: 80000, refKind: "strike" })];
  const views = new Map<string, MarketView | null>([[SYM, null]]);
  const out = await settleDue(entries, views, async () => null);
  assert.equal(out.entries[0].status, "open");
});

test("settleDue: legacy entry without refPrice stays open when view is null", async () => {
  const entries = [
    mkEntry({ refPrice: null, refKind: null, status: "open" }),
  ];
  const views = new Map<string, MarketView | null>([[SYM, null]]);
  const out = await settleDue(entries, views, async () => 999999);
  assert.equal(out.entries[0].status, "open");
});

test("settleDue: spot provider is called at most once per asset", async () => {
  const entries = [
    mkEntry({ refPrice: 80000, refKind: "strike", symbol: SYM }),
    mkEntry({
      refPrice: 80000,
      refKind: "strike",
      symbol: SYM,
      id: "second",
    }),
  ];
  const views = new Map<string, MarketView | null>([
    [SYM, null],
    [SYM, null],
  ]);
  let calls = 0;
  await settleDue(entries, views, async () => {
    calls++;
    return 81000;
  });
  assert.equal(calls, 1);
  assert.equal(entries[0].status, "settled");
  assert.equal(entries[1].status, "settled");
});

test("settleDue: no changes → ledger file is never written", async () => {
  // Earlier settle tests created <tmp>/data — remove it so we can prove this
  // no-op pass writes nothing.
  rmSync(path.join(tmpRoot, "data"), { recursive: true, force: true });
  const entries = [
    mkEntry({ expiresAtMs: Date.now() + 3_600_000, status: "open" }),
  ];
  const views = new Map<string, MarketView | null>([[SYM, null]]);
  await settleDue(entries, views, async () => null);
  assert.equal(existsSync(path.join(tmpRoot, "data")), false);
});

// --- CSV serializer (entriesToCsv) ------------------------------------------------

/** Minimal RFC 4180 parser for round-trip assertions (tests only). */
function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; }
        else { inQ = false; i += 1; }
      } else { field += ch; i += 1; }
    } else if (ch === '"') { inQ = true; i += 1; }
    else if (ch === ",") { cur.push(field); field = ""; i += 1; }
    else if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; i += 1; }
    else { field += ch; i += 1; }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}

function rowMap(e: LedgerEntry): Record<string, string> {
  const lines = paper.entriesToCsv([e]).trim().split("\n");
  assert.equal(lines.length, 2, "single entry → header + 1 row");
  return Object.fromEntries(COLS.map((h, i) => [h, lines[1].split(",")[i]]));
}

test("csv: header row is the stable 21-column list", () => {
  const [header] = paper.entriesToCsv([]).trim().split("\n");
  assert.equal(header, COLS.join(","));
  assert.equal(COLS.length, 21);
});

test("csv: empty ledger → header line only", () => {
  assert.equal(paper.entriesToCsv([]), COLS.join(",") + "\n");
});

test("csv: settled entry renders numbers, booleans, ISO timestamps, keeperhub columns", () => {
  const e = mkEntry({
    id: "e1",
    status: "settled",
    stakePct: 0.1,
    openAt: 1_750_000_000_000,
    expiresAtMs: 1_750_003_600_000,
    closeAt: 1_750_003_600_001,
    win: true,
    pnl: 1000,
    keeperhub: {
      executionId: "x", chain: "base-sepolia", amountUsd: 1000,
      from: "0xabc", to: "0xdef", txHash: "0xfeed",
      txLink: "https://sepolia.basescan.org/tx/0xfeed",
      status: "success", executedAt: 1,
    },
  });
  const r = rowMap(e);
  assert.equal(r.id, "e1");
  assert.equal(r.status, "settled");
  assert.equal(r.stake_pct, "0.1");
  assert.equal(r.stake, "1000");
  assert.equal(r.shares, "2000");
  assert.equal(r.entry_price, "0.5");
  assert.equal(r.open_at_ms, "1750000000000");
  assert.equal(r.open_at_iso, new Date(1_750_000_000_000).toISOString());
  assert.equal(r.close_at_iso, new Date(1_750_003_600_001).toISOString());
  assert.equal(r.win, "true");
  assert.equal(r.pnl, "1000");
  assert.equal(r.ref_price, "80000");
  assert.equal(r.ref_kind, "strike");
  assert.equal(r.keeperhub_status, "success");
  assert.equal(r.keeperhub_tx_hash, "0xfeed");
  assert.equal(r.keeperhub_tx_link, "https://sepolia.basescan.org/tx/0xfeed");
});

test("csv: losing entry renders win=false and negative pnl", () => {
  const r = rowMap(mkEntry({ id: "loss", status: "settled", win: false, pnl: -500, closeAt: 123 }));
  assert.equal(r.win, "false");
  assert.equal(r.pnl, "-500");
  assert.equal(r.status, "settled");
});

test("csv: open entry leaves close/win/pnl, ref and keeperhub columns empty (null → empty)", () => {
  const r = rowMap(mkEntry({ id: "open1", refPrice: null, refKind: null }));
  assert.equal(r.status, "open");
  assert.equal(r.close_at_ms, "");
  assert.equal(r.close_at_iso, "");
  assert.equal(r.win, "");
  assert.equal(r.pnl, "");
  assert.equal(r.ref_price, "");
  assert.equal(r.ref_kind, "");
  assert.equal(r.keeperhub_status, "");
  assert.equal(r.keeperhub_tx_hash, "");
});

test("csv: special characters (comma, quote, LF, CR) round-trip through quoting", () => {
  const cases = [
    "BTC,strike-80000",  // comma
    'ETH-"A/B"-1200',    // double quote
    "SOL\nup-down",      // line feed
    "XRP\rstrike",       // carriage return
  ];
  for (const sym of cases) {
    const rows = parseCsv(paper.entriesToCsv([mkEntry({ id: "q", symbol: sym })]));
    assert.equal(rows.length, 2, `record count stable for ${JSON.stringify(sym)}`);
    assert.equal(rows[1][COLS.indexOf("symbol")], sym, `round-trip for ${JSON.stringify(sym)}`);
  }
});

test("csv: rows sorted by openAt asc, then id asc (deterministic order)", () => {
  const a = mkEntry({ id: "zz", openAt: 300 });
  const b = mkEntry({ id: "aa", openAt: 300 });
  const c = mkEntry({ id: "mm", openAt: 100 });
  const rows = parseCsv(paper.entriesToCsv([a, c, b]));
  assert.deepEqual(
    rows.slice(1).map((r) => r[COLS.indexOf("id")]),
    ["mm", "aa", "zz"],
  );
});

test("csv: unix-ms 0 → 1970-01-01T00:00:00.000Z (UTC, no local timezone)", () => {
  const r = rowMap(mkEntry({ id: "t1" })); // mkEntry default openAt = 0
  assert.equal(r.open_at_ms, "0");
  assert.equal(r.open_at_iso, "1970-01-01T00:00:00.000Z");
  assert.equal(r.close_at_iso, ""); // closeAt null
});

test("csv: every row (header + entries) has exactly 21 columns", () => {
  const rows = parseCsv(
    paper.entriesToCsv([mkEntry({ id: "a1" }), mkEntry({ id: "a2", openAt: 5 })]),
  );
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.length, COLS.length);
});

test("csv: malformed (non-object / idless) entries are dropped, no throw", () => {
  const rows = parseCsv(
    paper.entriesToCsv([null, undefined, {}, mkEntry({ id: "ok1" })] as unknown as LedgerEntry[]),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1][COLS.indexOf("id")], "ok1");
});

// --- cleanup -------------------------------------------------------------------

test("cleanup temp sandbox", () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
