// ---------------------------------------------------------------------------
// EdgeScout — signal/edge observation log tests (node:test, no framework).
// Run: npm test
//
// The log file lives under process.cwd()/data — chdir to a temp dir BEFORE
// importing signals.ts so its module-level DATA_DIR points at the sandbox
// and no real log is ever touched.
//
// node:test runs top-level tests concurrently, so every test that touches
// the shared log file acquires a file-level async lock to serialize the
// read/modify/write cycle; each stateful test also starts from a clean data
// dir, making it independent of any other test's outcome.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "edgescout-signals-test-"));
process.chdir(tmpRoot);

const signals = await import("./signals.ts");
const {
  recordBoard,
  loadSignals,
  summarizeSignals,
  toObservation,
  MAX_SIGNAL_ROWS,
  SIGNAL_SAMPLE_INTERVAL_MS,
} = signals;
import type { MarketView } from "./market.ts";

const T0 = 1_700_000_000_000; // fixed "now" for deterministic tests
const DATA_DIR = path.join(tmpRoot, "data");
const FILE = path.join(DATA_DIR, "signal-history.json");

function clearData(): void {
  rmSync(DATA_DIR, { recursive: true, force: true });
}

function seedFile(observations: unknown[], lastAtMs: Record<string, number> = {}): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    FILE,
    JSON.stringify({ version: 1, observations, lastAtMs }),
    "utf8",
  );
}

// Serialize tests that share the log file / module-level fallback state.
let testLock: Promise<unknown> = Promise.resolve();
function withTestLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = testLock.then(fn, fn);
  testLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function mkView(
  symbol = "BTC-7900000-01SEP26-1200/tUSDC",
  pModel = 0.6,
  pImplied: number | null = 0.5,
  edge: number | null = 0.1,
  edgeKind: MarketView["edgeKind"] = "yes-underpriced",
): MarketView {
  return {
    symbol,
    asset: "BTC",
    strike: 79000,
    strikeLabel: "79000",
    upDown: false,
    expiresAt: new Date(T0 + 3_600_000).toISOString(),
    secondsToExpiry: 3600,
    active: true,
    book: {
      yesBid: pImplied == null ? null : pImplied - 0.02,
      yesAsk: pImplied == null ? null : pImplied + 0.02,
      depth: 500,
      timestamp: null,
      bids: [],
      asks: [],
    },
    pImplied,
    model: {
      pModel,
      dSigma: 0.5,
      secondsToExpiry: 3600,
      volAnnualized: 0.5,
      volSource: "candles",
    },
    edge,
    edgeKind,
    risk: 40,
    suggestion: null,
    openPrice: null,
    question: null,
    spot: 79500,
    ema: null,
  };
}

// --- toObservation -----------------------------------------------------------

test("toObservation maps all fields", () => {
  const o = toObservation(mkView(), T0);
  assert.equal(o.atMs, T0);
  assert.equal(o.symbol, "BTC-7900000-01SEP26-1200/tUSDC");
  assert.equal(o.asset, "BTC");
  assert.equal(o.upDown, false);
  assert.equal(o.secondsToExpiry, 3600);
  assert.equal(o.pModel, 0.6);
  assert.equal(o.pImplied, 0.5);
  assert.equal(o.edge, 0.1);
  assert.equal(o.edgeKind, "yes-underpriced");
  assert.equal(o.spot, 79500);
});

test("toObservation keeps nulls for a one-sided/empty book", () => {
  const o = toObservation(mkView("X", 0.5, null, null, "n/a"), T0);
  assert.equal(o.pImplied, null);
  assert.equal(o.edge, null);
  assert.equal(o.edgeKind, "n/a");
});

// --- summarizeSignals --------------------------------------------------------

test("summarizeSignals: empty rows → all zeros / nulls", () => {
  const s = summarizeSignals([]);
  assert.equal(s.total, 0);
  assert.equal(s.markets, 0);
  assert.equal(s.periodStartMs, null);
  assert.equal(s.periodEndMs, null);
  assert.equal(s.withBook, 0);
  assert.equal(s.edgeGe3pp, 0);
  assert.equal(s.edgeRate, null);
  assert.equal(s.meanAbsEdge, null);
  assert.equal(s.maxAbsEdge, null);
  assert.equal(s.maxAbsEdgeSymbol, null);
  assert.deepEqual(s.kindCounts, { aligned: 0, yesUnderpriced: 0, yesOverpriced: 0, noBook: 0 });
  assert.deepEqual(s.recent, []);
  assert.deepEqual(s.topEdges, []);
});

test("summarizeSignals: edge frequency / size / kinds on known rows", () => {
  const rows = [
    toObservation(mkView("A", 0.7, 0.5, 0.2, "yes-underpriced"), T0),
    toObservation(mkView("B", 0.51, 0.52, -0.01, "aligned"), T0 + 1000),
    toObservation(mkView("A", 0.5, null, null, "n/a"), T0 + 2000),
    toObservation(mkView("B", 0.52, 0.5, 0.02, "yes-overpriced"), T0 + 3000),
  ];
  const s = summarizeSignals(rows);
  assert.equal(s.total, 4);
  assert.equal(s.markets, 2);
  assert.equal(s.periodStartMs, T0);
  assert.equal(s.periodEndMs, T0 + 3000);
  assert.equal(s.withBook, 3);
  assert.equal(s.edgeGe3pp, 1); // only |0.2| >= 0.03
  assert.equal(s.edgeRate, 1 / 3);
  assert.equal(s.meanAbsEdge, (0.2 + 0.01 + 0.02) / 3);
  assert.equal(s.maxAbsEdge, 0.2);
  assert.equal(s.maxAbsEdgeSymbol, "A");
  assert.deepEqual(s.kindCounts, { aligned: 1, yesUnderpriced: 1, yesOverpriced: 1, noBook: 1 });
  assert.equal(s.recent.length, 4);
  assert.equal(s.recent[0].atMs, T0 + 3000); // newest first
  assert.equal(s.recent[3].atMs, T0);
});

test("summarizeSignals: recent is capped at 20, newest first", () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    toObservation(mkView(`S${i}`), T0 + i * 1000),
  );
  const s = summarizeSignals(rows);
  assert.equal(s.total, 25);
  assert.equal(s.recent.length, 20);
  assert.equal(s.recent[0].atMs, T0 + 24_000); // newest first
  assert.equal(s.recent[19].atMs, T0 + 5_000); // oldest of the retained 20
});

test("summarizeSignals: rows with a non-finite atMs are excluded from the period", () => {
  const rows = [
    { ...toObservation(mkView("A"), T0), atMs: Number.NaN },
    toObservation(mkView("B"), T0 + 5000),
  ];
  const s = summarizeSignals(rows);
  assert.equal(s.total, 2);
  assert.equal(s.periodStartMs, T0 + 5000);
  assert.equal(s.periodEndMs, T0 + 5000);
});

// --- summarizeSignals: topEdges ------------------------------------------------

test("summarizeSignals: topEdges ranks by |edge| desc, capped at 5", () => {
  const rows = [
    toObservation(mkView("A", 0.6, 0.5, 0.05, "yes-underpriced"), T0),
    toObservation(mkView("B", 0.5, 0.62, -0.12, "yes-overpriced"), T0 + 1000),
    toObservation(mkView("C", 0.55, 0.5, 0.05, "yes-underpriced"), T0 + 2000),
    toObservation(mkView("D", 0.5, 0.44, 0.06, "yes-underpriced"), T0 + 3000),
    toObservation(mkView("E", 0.5, 0.5, 0.01, "aligned"), T0 + 4000),
    toObservation(mkView("F", 0.5, 0.49, 0.01, "aligned"), T0 + 5000),
    toObservation(mkView("G", 0.49, 0.5, -0.01, "yes-overpriced"), T0 + 6000),
  ];
  const s = summarizeSignals(rows);
  assert.equal(s.topEdges.length, 5);
  assert.equal(s.topEdges[0].symbol, "B"); // |−0.12| largest
  assert.equal(s.topEdges[0].edge, -0.12);
  assert.deepEqual(s.topEdges.slice(1).map((t) => t.symbol), ["D", "C", "A", "G"]);
  // D=0.06; A/C tie at 0.05 → C newer; E/G tie at 0.01 → G newer.
});

test("summarizeSignals: topEdges tie-breaks by newest atMs, then symbol asc", () => {
  const rows = [
    toObservation(mkView("A", 0.5, 0.55, -0.05, "yes-overpriced"), T0),
    toObservation(mkView("B", 0.55, 0.5, 0.05, "yes-underpriced"), T0 + 1000),
    toObservation(mkView("C", 0.5, 0.55, -0.05, "yes-overpriced"), T0 + 1000),
  ];
  const s = summarizeSignals(rows);
  assert.deepEqual(s.topEdges.map((t) => t.symbol), ["B", "C", "A"]);
});

test("summarizeSignals: topEdges excludes rows without a finite edge", () => {
  const rows = [
    toObservation(mkView("A", 0.5, null, null, "n/a"), T0),
    { ...toObservation(mkView("B", 0.5, 0.45, 0.05, "yes-underpriced"), T0 + 1000), edge: Number.NaN },
    toObservation(mkView("C", 0.5, 0.4, 0.1, "yes-underpriced"), T0 + 2000),
  ];
  const s = summarizeSignals(rows);
  assert.deepEqual(s.topEdges.map((t) => t.symbol), ["C"]);
});

test("summarizeSignals: topEdges spans the full window, not just the recent 20", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    toObservation(mkView(`S${i}`, 0.5, 0.501, 0.001, "aligned"), T0 + i * 1000),
  );
  rows[0] = { ...rows[0], edge: 0.25, pImplied: 0.35, edgeKind: "yes-underpriced" };
  const s = summarizeSignals(rows);
  assert.equal(s.recent.length, 20);
  assert.ok(!s.recent.some((r) => r.atMs === T0)); // largest-edge row is outside recent
  assert.equal(s.topEdges[0].symbol, "S0");
  assert.equal(s.topEdges[0].edge, 0.25);
  assert.equal(s.topEdges.length, 5);
});

test("summarizeSignals: topEdges carries symbol/asset/edge/edgeKind/atMs", () => {
  const rows = [toObservation(mkView("X", 0.5, 0.4, 0.1, "yes-underpriced"), T0 + 777)];
  const s = summarizeSignals(rows);
  assert.deepEqual(s.topEdges, [
    { symbol: "X", asset: "BTC", edge: 0.1, edgeKind: "yes-underpriced", atMs: T0 + 777 },
  ]);
});

// --- recordBoard: sampling gate ----------------------------------------------

test(
  "recordBoard: first sample records, repeats within 60s are gated",
  async () => {
    await withTestLock(async () => {
      clearData();
      assert.equal(await recordBoard([mkView("A")], T0), 1);
      assert.equal(await recordBoard([mkView("A")], T0 + 30_000), 0);
      assert.equal(await recordBoard([mkView("A")], T0 + 59_999), 0);
      assert.equal(await recordBoard([mkView("A")], T0 + SIGNAL_SAMPLE_INTERVAL_MS), 1);

      const file = await loadSignals();
      assert.equal(file.observations.length, 2);
      assert.deepEqual(
        file.observations.map((o) => o.atMs),
        [T0, T0 + SIGNAL_SAMPLE_INTERVAL_MS],
      );
      assert.equal(file.lastAtMs["A"], T0 + SIGNAL_SAMPLE_INTERVAL_MS);
    });
  },
);

test(
  "recordBoard: different markets are sampled independently",
  async () => {
    await withTestLock(async () => {
      clearData();
      assert.equal(await recordBoard([mkView("A")], T0), 1);
      assert.equal(await recordBoard([mkView("B")], T0 + 30_000), 1);
      // At T0+61s: A (last sampled at T0) is eligible again; B (last at T0+30s) is not.
      assert.equal(await recordBoard([mkView("A"), mkView("B")], T0 + 61_000), 1);

      const file = await loadSignals();
      assert.equal(file.observations.length, 3);
      assert.deepEqual(
        file.observations.map((o) => o.symbol),
        ["A", "B", "A"],
      );
    });
  },
);

test(
  "recordBoard: gate survives a process restart (persisted lastAtMs)",
  async () => {
    await withTestLock(async () => {
      // Simulate a previous run that already sampled symbol A at T0.
      seedFile([toObservation(mkView("A"), T0)], { A: T0 });
      assert.equal(await recordBoard([mkView("A")], T0 + 5_000), 0);
      assert.equal(await recordBoard([mkView("A")], T0 + 65_000), 1);
    });
  },
);

// --- recordBoard: ring buffer cap ---------------------------------------------

test(
  "recordBoard: ring buffer trims to MAX_SIGNAL_ROWS, oldest drop off",
  async () => {
    await withTestLock(async () => {
      clearData();
      const old = Array.from({ length: MAX_SIGNAL_ROWS + 5 }, (_, i) =>
        toObservation(mkView(`OLD-${i}`), T0 - (MAX_SIGNAL_ROWS + 5 - i) * 1000),
      );
      seedFile(old);
      assert.equal(await recordBoard([mkView("NEW")], T0), 1);

      const file = await loadSignals();
      assert.equal(file.observations.length, MAX_SIGNAL_ROWS);
      assert.equal(file.observations[0].symbol, `OLD-${6}`); // oldest 6 dropped
      assert.equal(file.observations[file.observations.length - 1].symbol, "NEW");
    });
  },
);

test(
  "recordBoard: lastAtMs entries older than 24h are pruned",
  async () => {
    await withTestLock(async () => {
      clearData();
      const stale = T0 - 48 * 3_600_000;
      seedFile([toObservation(mkView("OLD-MARKET"), stale)], { "OLD-MARKET": stale });
      assert.equal(await recordBoard([mkView("A")], T0), 1);

      const file = await loadSignals();
      assert.equal(file.lastAtMs["A"], T0);
      assert.equal("OLD-MARKET" in file.lastAtMs, false);
    });
  },
);

// --- recordBoard: robustness ---------------------------------------------------

test(
  "recordBoard: malformed file is recovered, then a valid file is written",
  async () => {
    await withTestLock(async () => {
      clearData();
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(FILE, "{not json at all", "utf8");
      const file = await loadSignals();
      assert.deepEqual(file.observations, []);

      assert.equal(await recordBoard([mkView("A")], T0), 1);
      const reread = JSON.parse(readFileSync(FILE, "utf8"));
      assert.equal(reread.version, 1);
      assert.equal(reread.observations.length, 1);
    });
  },
);

test(
  "loadSignals: wrong version is treated as empty",
  async () => {
    await withTestLock(async () => {
      clearData();
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(
        FILE,
        JSON.stringify({ version: 2, observations: [], lastAtMs: {} }),
        "utf8",
      );
      const file = await loadSignals();
      assert.deepEqual(file.observations, []);
      assert.deepEqual(file.lastAtMs, {});
    });
  },
);

test(
  "recordBoard: no write when every market is gated",
  async () => {
    await withTestLock(async () => {
      clearData();
      assert.equal(await recordBoard([mkView("A")], T0), 1);
      const before = readFileSync(FILE, "utf8");
      assert.equal(await recordBoard([mkView("A")], T0 + 1000), 0);
      assert.equal(readFileSync(FILE, "utf8"), before);
    });
  },
);

// --- cleanup -------------------------------------------------------------------

test("cleanup temp sandbox", () => {
  // Waits for the whole locked chain, so it runs after every stateful test.
  return withTestLock(async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
