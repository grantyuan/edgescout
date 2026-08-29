// ---------------------------------------------------------------------------
// EdgeScout — deterministic model tests (node:test, no framework).
// Run: npm test
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import {
  normCdf,
  modelYesProbability,
  classifyEdge,
  riskScore,
  sizePosition,
  EDGE_THRESHOLD,
} from "./model.ts";

// --- normCdf ---------------------------------------------------------------

test("normCdf: symmetry and key values", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(0) - (normCdf(1) + normCdf(-1)) / 2) < 1e-9);
  // monotone
  const xs = [-4, -2, 0, 2, 4];
  for (let i = 1; i < xs.length; i++) {
    assert.ok(normCdf(xs[i]) > normCdf(xs[i - 1]));
  }
});

// --- modelYesProbability ---------------------------------------------------

test("model: at-the-money (S == ref) gives p ≈ 0.5", () => {
  const out = modelYesProbability({
    asset: "BTC",
    spot: 80000,
    ema: null,
    strike: 80000,
    secondsToExpiry: 3600,
    volAnnualized: 0.5,
    volSource: "candles",
  });
  assert.ok(Math.abs(out.pModel - 0.5) < 0.02, `got ${out.pModel}`);
  assert.ok(Math.abs(out.dSigma) < 0.05);
});

test("model: deep ITM with long horizon → p → 1", () => {
  const out = modelYesProbability({
    asset: "BTC",
    spot: 90000,
    ema: null,
    strike: 80000,
    secondsToExpiry: 24 * 3600,
    volAnnualized: 0.5,
    volSource: "candles",
  });
  assert.ok(out.pModel > 0.95, `got ${out.pModel}`);
});

test("model: deep OTM → p → 0", () => {
  const out = modelYesProbability({
    asset: "BTC",
    spot: 70000,
    ema: null,
    strike: 80000,
    secondsToExpiry: 24 * 3600,
    volAnnualized: 0.5,
    volSource: "candles",
  });
  assert.ok(out.pModel < 0.05, `got ${out.pModel}`);
});

test("model: short horizon is more binary (ITM → closer to 1)", () => {
  const longH = modelYesProbability({
    asset: "BTC",
    spot: 80500,
    ema: null,
    strike: 80000,
    secondsToExpiry: 6 * 3600,
    volAnnualized: 0.5,
    volSource: "candles",
  });
  const shortH = modelYesProbability({
    asset: "BTC",
    spot: 80500,
    ema: null,
    strike: 80000,
    secondsToExpiry: 300,
    volAnnualized: 0.5,
    volSource: "candles",
  });
  assert.ok(shortH.pModel > longH.pModel);
});

test("model: at expiry, settles by sign(S - ref)", () => {
  const win = modelYesProbability({
    asset: "BTC",
    spot: 80100,
    ema: null,
    strike: 80000,
    secondsToExpiry: 0,
    volAnnualized: 0.5,
    volSource: "candles",
  });
  const lose = modelYesProbability({
    asset: "BTC",
    spot: 79900,
    ema: null,
    strike: 80000,
    secondsToExpiry: 0,
    volAnnualized: 0.5,
    volSource: "candles",
  });
  assert.equal(win.pModel, 1);
  assert.equal(lose.pModel, 0);
});

test("model: reference priority strike > openPrice > ema", () => {
  const base = {
    asset: "BTC",
    spot: 80000,
    ema: 79000,
    secondsToExpiry: 3600,
    volAnnualized: 0.5,
    volSource: "candles" as const,
  };
  const withStrike = modelYesProbability({ ...base, strike: 80000, openPrice: null });
  const withOpen = modelYesProbability({ ...base, strike: null, openPrice: 80000 });
  const withEma = modelYesProbability({ ...base, strike: null, openPrice: null });
  // strike/open at spot → ~0.5; EMA far below → much higher
  assert.ok(Math.abs(withStrike.pModel - 0.5) < 0.02);
  assert.ok(Math.abs(withOpen.pModel - 0.5) < 0.02);
  assert.ok(withEma.pModel > 0.85);
});

test("model: no reference → 0.5 coin-flip, not NaN", () => {
  const out = modelYesProbability({
    asset: "BTC",
    spot: 80000,
    ema: null,
    strike: null,
    secondsToExpiry: 3600,
    volAnnualized: 0.5,
    volSource: "default",
  });
  assert.equal(out.pModel, 0.5);
  assert.ok(Number.isFinite(out.dSigma));
});

// --- classifyEdge ----------------------------------------------------------

test("classifyEdge: underpriced / overpriced / aligned at threshold", () => {
  const up = classifyEdge(0.6, 0.55);
  assert.equal(up.kind, "yes-underpriced");
  assert.ok(up.edge > 0);

  const down = classifyEdge(0.55, 0.6);
  assert.equal(down.kind, "yes-overpriced");
  assert.ok(down.edge < 0);

  const aligned = classifyEdge(0.55, 0.56);
  assert.equal(aligned.kind, "aligned");
});

test("classifyEdge: threshold is exactly EDGE_THRESHOLD", () => {
  const at = classifyEdge(0.5 + EDGE_THRESHOLD, 0.5);
  assert.ok(at.kind === "yes-underpriced" || at.kind === "aligned");
});

// --- riskScore ---------------------------------------------------------------

test("riskScore: thin book + stale data + short window → high risk", () => {
  const r = riskScore({
    dSigma: 0.1,
    secondsToExpiry: 60,
    bookDepth: 10,
    bookAgeMs: 30_000,
  });
  assert.ok(r > 60, `got ${r}`);
});

test("riskScore: liquid fresh book, far OTM → low risk", () => {
  const r = riskScore({
    dSigma: 2.5,
    secondsToExpiry: 3600,
    bookDepth: 5000,
    bookAgeMs: 500,
  });
  assert.ok(r < 35, `got ${r}`);
});

// --- sizePosition ----------------------------------------------------------

test("sizePosition: quarter-Kelly math on a clean edge", () => {
  // p = 0.6, c = 0.5 → f* = (0.6-0.5)/(0.5*0.5) = 0.4 → 1/4 Kelly = 0.10
  const out = sizePosition({
    pModel: 0.6,
    yesAsk: 0.5,
    yesBid: 0.48,
    kellyFraction: 0.25,
    maxPositionPct: 0.2,
  });
  assert.equal(out.action, "BUY_YES");
  assert.ok(Math.abs(out.kellyRaw - 0.4) < 1e-9, `kellyRaw ${out.kellyRaw}`);
  assert.ok(Math.abs(out.positionPct - 0.1) < 1e-9, `pct ${out.positionPct}`);
  assert.equal(out.entryPrice, 0.5);
});

test("sizePosition: edge on the NO side buys NO at 1 - bid", () => {
  const out = sizePosition({
    pModel: 0.35,
    yesAsk: 0.52,
    yesBid: 0.48,
    kellyFraction: 0.25,
    maxPositionPct: 0.2,
  });
  // implied mid 0.5 > model 0.35 + threshold → NO underpriced
  assert.equal(out.action, "BUY_NO");
  // NO entry price = 1 - yesBid
  assert.ok(Math.abs(out.entryPrice - 0.52) < 1e-9, `entry ${out.entryPrice}`);
});

test("sizePosition: no edge beyond threshold → SKIP", () => {
  const out = sizePosition({
    pModel: 0.52,
    yesAsk: 0.53,
    yesBid: 0.49,
    kellyFraction: 0.25,
    maxPositionPct: 0.2,
  });
  assert.equal(out.action, "SKIP");
  assert.equal(out.positionPct, 0);
});

test("sizePosition: position capped at maxPositionPct", () => {
  // Huge edge: p=0.95, c=0.1 → f*=(0.85)/(0.09)=9.44 → 1/4 = 2.36 → capped
  const out = sizePosition({
    pModel: 0.95,
    yesAsk: 0.1,
    yesBid: 0.08,
    kellyFraction: 0.25,
    maxPositionPct: 0.2,
  });
  assert.equal(out.action, "BUY_YES");
  assert.ok(out.positionPct <= 0.2, `pct ${out.positionPct}`);
});

test("sizePosition: degenerate books (missing ask/bid) → SKIP, no crash", () => {
  const out = sizePosition({
    pModel: 0.6,
    yesAsk: null as unknown as number,
    yesBid: null as unknown as number,
    kellyFraction: 0.25,
    maxPositionPct: 0.2,
  });
  assert.equal(out.action, "SKIP");
});
