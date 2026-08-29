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
const { settleDue, yesOutcome } = paper;
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

// --- cleanup -------------------------------------------------------------------

test("cleanup temp sandbox", () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
