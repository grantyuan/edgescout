// ---------------------------------------------------------------------------
// EdgeScout — model scorecard tests (node:test, no framework, no network).
// The pure core (summarizeEvaluated / resolveStrikeScale / predictsYes) is
// unit-tested here; buildScorecard's indexer/candle I/O is covered by the
// /api/scorecard integration probe (live testnet), never by tests.
// Run: npm test
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEvaluated, resolveStrikeScale, predictsYes } from "./scorecard.ts";

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
