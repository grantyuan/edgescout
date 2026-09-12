// ---------------------------------------------------------------------------
// EdgeScout — model scorecard tests (node:test, no framework, no network).
// The pure core (summarizeEvaluated / resolveStrikeScale / predictsYes /
// summarizeByAsset / summarizeCalibration) is unit-tested here;
// buildScorecard's indexer/candle I/O is covered by the /api/scorecard
// integration probe (live testnet), never by tests.
// Run: npm test
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeEvaluated,
  resolveStrikeScale,
  predictsYes,
  summarizeByAsset,
  summarizeCalibration,
  SCORECARD_ASSETS,
} from "./scorecard.ts";

// --- summarizeEvaluated ------------------------------------------------------

test("summarizeEvaluated: empty rows → all nulls, evaluated 0", () => {
  const s = summarizeEvaluated([]);
  assert.equal(s.evaluated, 0);
  assert.equal(s.correct, 0);
  assert.equal(s.hitRate, null);
  assert.equal(s.brierScore, null);
  assert.equal(s.meanPModel, null);
});

test("summarizeEvaluated: hit rate / brier / mean on known rows", () => {
  // With the >= 0.5 YES rule: 0.8→YES (correct, outcome YES); 0.3→NO (wrong,
  // outcome YES); 0.5→YES on both outcome-NO rows (wrong, wrong). → 1/4.
  const s = summarizeEvaluated([
    { pModel: 0.8, outcomeYes: true },
    { pModel: 0.3, outcomeYes: true },
    { pModel: 0.5, outcomeYes: false },
    { pModel: 0.5, outcomeYes: false },
  ]);
  assert.equal(s.evaluated, 4);
  assert.equal(s.correct, 1);
  assert.ok(
    Math.abs(s.hitRate! - 0.25) < 1e-9,
    `hitRate ${s.hitRate} != 0.25`,
  );
  // (0.8-1)^2 + (0.3-1)^2 + (0.5-0)^2 + (0.5-0)^2 = 0.04+0.49+0.25+0.25
  assert.ok(
    Math.abs(s.brierScore! - 0.2575) < 1e-9,
    `brier ${s.brierScore} != 0.2575`,
  );
  assert.ok(
    Math.abs(s.meanPModel! - 0.525) < 1e-9,
    `mean ${s.meanPModel} != 0.525`,
  );
});

test("summarizeEvaluated: all-correct rows → hitRate 1, brier near 0", () => {
  const s = summarizeEvaluated([
    { pModel: 0.9, outcomeYes: true },
    { pModel: 0.1, outcomeYes: false },
  ]);
  assert.equal(s.correct, 2);
  assert.equal(s.evaluated, 2);
  assert.ok(Math.abs(s.hitRate! - 1) < 1e-9);
  // (0.9-1)^2 + (0.1-0)^2 = 0.01 + 0.01 → mean 0.01
  assert.ok(
    Math.abs(s.brierScore! - 0.01) < 1e-9,
    `brier ${s.brierScore}`,
  );
});

test("summarizeEvaluated: all-wrong rows → hitRate 0", () => {
  const s = summarizeEvaluated([
    { pModel: 0.4, outcomeYes: true },
    { pModel: 0.6, outcomeYes: false },
  ]);
  assert.equal(s.correct, 0);
  assert.ok(Math.abs(s.hitRate! - 0) < 1e-9);
});

// --- predictsYes --------------------------------------------------------------

test("predictsYes: boundary pModel 0.5 predicts YES (>= 0.5 rule)", () => {
  assert.equal(predictsYes(0.5), true);
  assert.equal(predictsYes(0.5000001), true);
  assert.equal(predictsYes(0.4999999), false);
  assert.equal(predictsYes(1), true);
  assert.equal(predictsYes(0), false);
});

// --- resolveStrikeScale -------------------------------------------------------

test("resolveStrikeScale: ×100 raw strike resolves to human price", () => {
  // 8034190 = 80341.90 × 100; spot 80000 → /100 candidate is much closer.
  assert.ok(Math.abs(resolveStrikeScale(8034190, 80000) - 80341.9) < 1e-9);
  // ETH-scale market: 250797 = 2507.97 × 100; spot 2500.
  assert.ok(Math.abs(resolveStrikeScale(250797, 2500) - 2507.97) < 1e-9);
});

test("resolveStrikeScale: raw already human-scale (spot near raw)", () => {
  // If the raw value itself is within a sane range of spot (e.g. a venue that
  // stores human strikes), the unscaled candidate wins.
  const r = resolveStrikeScale(80341, 80000);
  assert.ok(Math.abs(r - 80341) < 1e-9, `got ${r}`);
});

test("resolveStrikeScale: no sane scale → raw/100 (×100 convention)", () => {
  // Both candidates >4× away from spot: fall back to the raw/100 convention.
  assert.equal(resolveStrikeScale(123456789, 80000), 1234567.89);
});

test("resolveStrikeScale: degenerate spot (0 / NaN) → raw/100", () => {
  assert.equal(resolveStrikeScale(8034190, 0), 80341.9);
  assert.equal(resolveStrikeScale(8034190, Number.NaN), 80341.9);
});

// --- summarizeByAsset ---------------------------------------------------------

test("summarizeByAsset: empty rows → both assets 0/nulls, fixed order BTC then ETH", () => {
  assert.deepEqual(SCORECARD_ASSETS, ["BTC", "ETH"]);
  const out = summarizeByAsset([]);
  assert.deepEqual(out, [
    { asset: "BTC", evaluated: 0, correct: 0, hitRate: null, brierScore: null, meanPModel: null },
    { asset: "ETH", evaluated: 0, correct: 0, hitRate: null, brierScore: null, meanPModel: null },
  ]);
});

test("summarizeByAsset: splits hit-rate/brier per asset, ignores unknown assets, order fixed", () => {
  // BTC: (0.9,Y) correct; (0.6,N) wrong (calls YES, settles NO);
  // (0.4,Y) wrong (calls NO, settles YES) → 1/3, brier (0.01+0.36+0.36)/3
  // ETH: (0.3,Y) wrong → 0/1, brier (0.7)^2 = 0.49
  // SOL row must be ignored entirely.
  const out = summarizeByAsset([
    { asset: "ETH", pModel: 0.3, outcomeYes: true },
    { asset: "BTC", pModel: 0.9, outcomeYes: true },
    { asset: "BTC", pModel: 0.6, outcomeYes: false },
    { asset: "SOL", pModel: 0.5, outcomeYes: true },
    { asset: "BTC", pModel: 0.4, outcomeYes: true },
  ]);
  assert.deepEqual(out.map((a) => a.asset), ["BTC", "ETH"]);
  const btc = out[0];
  assert.equal(btc.evaluated, 3);
  assert.equal(btc.correct, 1);
  assert.ok(Math.abs(btc.hitRate! - 1 / 3) < 1e-9, `hitRate ${btc.hitRate}`);
  assert.ok(Math.abs(btc.brierScore! - 0.73 / 3) < 1e-9, `brier ${btc.brierScore}`);
  assert.ok(Math.abs(btc.meanPModel! - 1.9 / 3) < 1e-9, `mean ${btc.meanPModel}`);
  const eth = out[1];
  assert.equal(eth.evaluated, 1);
  assert.equal(eth.correct, 0);
  assert.ok(Math.abs(eth.hitRate! - 0) < 1e-9);
  assert.ok(Math.abs(eth.brierScore! - 0.49) < 1e-9, `brier ${eth.brierScore}`);
  assert.ok(Math.abs(eth.meanPModel! - 0.3) < 1e-9);
});

test("summarizeByAsset: custom asset list order is honored", () => {
  const out = summarizeByAsset([{ asset: "ETH", pModel: 0.8, outcomeYes: true }], ["ETH", "BTC"]);
  assert.deepEqual(out.map((a) => a.asset), ["ETH", "BTC"]);
  assert.equal(out[0].evaluated, 1);
  assert.ok(Math.abs(out[0].hitRate! - 1) < 1e-9);
  assert.equal(out[1].evaluated, 0);
  assert.equal(out[1].hitRate, null);
});

// --- summarizeCalibration -----------------------------------------------------

test("summarizeCalibration: empty rows → 5 empty buckets with nulls", () => {
  const out = summarizeCalibration([]);
  assert.equal(out.length, 5);
  assert.deepEqual(
    out.map((b) => [b.from, b.to]),
    [
      [0, 0.2],
      [0.2, 0.4],
      [0.4, 0.6],
      [0.6, 0.8],
      [0.8, 1],
    ],
  );
  assert.deepEqual(
    out.map((b) => b.bucket),
    ["0.00-0.20", "0.20-0.40", "0.40-0.60", "0.60-0.80", "0.80-1.00"],
  );
  for (const b of out) {
    assert.equal(b.count, 0);
    assert.equal(b.meanPModel, null);
    assert.equal(b.empiricalYesRate, null);
  }
});

test("summarizeCalibration: boundaries — 'from' inclusive, last bucket includes 1.0", () => {
  const out = summarizeCalibration([
    { pModel: 0.199999, outcomeYes: false }, // bucket 0
    { pModel: 0.2, outcomeYes: true }, // bucket 1 (from-inclusive)
    { pModel: 0.4, outcomeYes: false }, // bucket 2
    { pModel: 0.8, outcomeYes: false }, // bucket 4
    { pModel: 1.0, outcomeYes: true }, // bucket 4 (last inclusive)
  ]);
  assert.deepEqual(out.map((b) => b.count), [1, 1, 1, 0, 2]);
});

test("summarizeCalibration: mean pModel + empirical YES rate per bucket", () => {
  const out = summarizeCalibration([
    { pModel: 0.1, outcomeYes: false },
    { pModel: 0.3, outcomeYes: true },
    { pModel: 0.5, outcomeYes: true },
    { pModel: 0.9, outcomeYes: false },
  ]);
  assert.deepEqual(out.map((b) => b.count), [1, 1, 1, 0, 1]);
  assert.ok(Math.abs(out[0].meanPModel! - 0.1) < 1e-9);
  assert.equal(out[0].empiricalYesRate, 0);
  assert.ok(Math.abs(out[1].meanPModel! - 0.3) < 1e-9);
  assert.equal(out[1].empiricalYesRate, 1);
  assert.equal(out[2].empiricalYesRate, 1);
  assert.equal(out[3].count, 0);
  assert.equal(out[4].empiricalYesRate, 0);
});

test("summarizeCalibration: defensive — non-finite/out-of-range pModel dropped", () => {
  const out = summarizeCalibration([
    { pModel: Number.NaN, outcomeYes: true },
    { pModel: -0.1, outcomeYes: true },
    { pModel: 1.5, outcomeYes: false },
    { pModel: 0.5, outcomeYes: true },
  ]);
  assert.equal(out.reduce((n, b) => n + b.count, 0), 1);
  assert.equal(out[2].count, 1);
  assert.ok(Math.abs(out[2].meanPModel! - 0.5) < 1e-9);
  assert.equal(out[2].empiricalYesRate, 1);
});

test("summarizeCalibration: all rows in one middle bucket", () => {
  const out = summarizeCalibration([
    { pModel: 0.65, outcomeYes: true },
    { pModel: 0.7, outcomeYes: false },
  ]);
  assert.deepEqual(out.map((b) => b.count), [0, 0, 0, 2, 0]);
  assert.ok(Math.abs(out[3].meanPModel! - 0.675) < 1e-9);
  assert.ok(Math.abs(out[3].empiricalYesRate! - 0.5) < 1e-9);
});
