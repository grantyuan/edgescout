// ---------------------------------------------------------------------------
// EdgeScout — probability model + risk scoring + position sizing
//
// The model is intentionally simple and fully deterministic:
//   * fair value of a strike market via a zero-drift Brownian-motion
//     transition probability (Black-Scholes "risk-neutral" p, the drift term
//     is negligible on minute/hour horizons);
//   * up/down (strike-0) markets use the window open price as reference
//     (falling back to the venue EMA mark when the open can't be fetched);
//   * the "edge" is model probability vs. the book's implied probability.
// The LLM layer only narrates and qualifies — all numbers come from this
// module, so the report can never hallucinate a price or a probability.
// ---------------------------------------------------------------------------

export interface ModelInput {
  /** Underlying asset code, e.g. "BTC" / "ETH". */
  asset: string;
  /** Current spot price (human units). */
  spot: number;
  /** Venue EMA mark price (last-resort reference for up/down markets). */
  ema: number | null;
  /** Strike price in human units, or null for up/down (strike-0) markets. */
  strike: number | null;
  /** Window open price (primary reference for up/down markets), if available. */
  openPrice?: number | null;
  /** Seconds until market expiry; 0 when already expired. */
  secondsToExpiry: number;
  /** Annualized volatility (default when candles unavailable). */
  volAnnualized: number;
  /** Volatility source: "candles" | "default". */
  volSource: "candles" | "default";
}

export interface ModelOutput {
  /** Model probability that YES pays out (0..1). */
  pModel: number;
  /** d in standard deviations: ln(S/K)/(sigma*sqrt(tau)). */
  dSigma: number;
  /** Seconds to expiry used. */
  secondsToExpiry: number;
  volAnnualized: number;
  volSource: "candles" | "default";
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (|err| < 1.5e-7). */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * (ax / Math.SQRT2));
  const y =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
    t;
  const erf = 1 - y * Math.exp(-(ax * ax) / 2);
  return 0.5 * (1 + sign * erf);
}

/**
 * Fair value of the YES outcome.
 *
 * Strike markets: P(S_T >= K) ≈ Φ(ln(S/K) / (σ√τ)) under zero drift.
 * Up/down markets (K = 0): same formula with the venue EMA mark as K.
 * When S equals the reference the probability is exactly 0.5; at expiry the
 * sign of S - K decides.
 */
export function modelYesProbability(inp: ModelInput): ModelOutput {
  const ref = inp.strike ?? inp.openPrice ?? inp.ema;
  const tauYears = Math.max(inp.secondsToExpiry, 0) / SECONDS_PER_YEAR;
  let p: number;
  let d: number;
  if (ref == null || ref <= 0 || !(inp.spot > 0)) {
    p = 0.5;
    d = 0;
  } else if (inp.secondsToExpiry <= 0) {
    // Settled semantics: decide by current price vs. reference.
    p = inp.spot >= ref ? 1 : 0;
    d = 0;
  } else {
    const sigma = inp.volAnnualized;
    d = Math.log(inp.spot / ref) / (sigma * Math.sqrt(tauYears));
    p = normCdf(d);
  }
  p = Math.min(1, Math.max(0, p));
  return {
    pModel: p,
    dSigma: d,
    secondsToExpiry: inp.secondsToExpiry,
    volAnnualized: inp.volAnnualized,
    volSource: inp.volSource,
  };
}

// ---------------------------------------------------------------------------
// Edge classification
// ---------------------------------------------------------------------------

export type EdgeKind = "aligned" | "yes-underpriced" | "yes-overpriced";

export const EDGE_THRESHOLD = 0.03;

export function classifyEdge(pModel: number, pImplied: number): {
  kind: EdgeKind;
  edge: number;
} {
  const edge = pModel - pImplied;
  if (edge >= EDGE_THRESHOLD) return { kind: "yes-underpriced", edge };
  if (edge <= -EDGE_THRESHOLD) return { kind: "yes-overpriced", edge };
  return { kind: "aligned", edge };
}

// ---------------------------------------------------------------------------
// Risk score (0-100, higher = riskier). Deterministic blend of:
//   nearness   — how close spot is to the strike in σ units (at-the-money
//                markets are the most uncertain);
//   binaryness — shorter horizons flip to all-or-nothing faster;
//   liquidity  — thin books move on small orders;
//   staleness  — how old the book snapshot is.
// ---------------------------------------------------------------------------

export interface RiskInput {
  dSigma: number;
  secondsToExpiry: number;
  /** Sum of YES-side top-5 bid + ask quantities (share units). */
  bookDepth: number;
  /** Book age in ms (now - book.timestamp). */
  bookAgeMs: number;
}

const LIQUID_DEPTH = 500; // share units considered "liquid" on testnet

export function riskScore(inp: RiskInput): number {
  const nearness = 1 - Math.min(1, Math.abs(inp.dSigma) / 2);
  const hours = Math.max(inp.secondsToExpiry, 1) / 3600;
  const binaryness = Math.min(1, 2 / hours);
  const liquidity = Math.min(1, inp.bookDepth / LIQUID_DEPTH);
  const staleness = Math.min(1, Math.max(0, inp.bookAgeMs) / 30_000);
  const score =
    0.35 * nearness + 0.25 * binaryness + 0.25 * (1 - liquidity) + 0.15 * staleness;
  return Math.round(100 * score);
}

// ---------------------------------------------------------------------------
// Position sizing — fractional Kelly on the binary contract price.
// Kelly fraction of bankroll for YES at ask c with true prob p:
//   f* = (p - c) / (c (1 - c));  NO side mirrors with c' = 1 - bid, p' = 1-p.
// ---------------------------------------------------------------------------

export interface SizingInput {
  pModel: number;
  /** Best YES ask (buying YES) and bid (selling/NO side), human units. */
  yesAsk: number;
  yesBid: number;
  kellyFraction: number;
  maxPositionPct: number;
}

export interface SizingOutput {
  action: "SKIP" | "BUY_YES" | "BUY_NO";
  /** Kelly fraction of bankroll after fractional + cap applied. */
  positionPct: number;
  /** Raw (full) Kelly fraction, signed: + favors YES, - favors NO. */
  kellyRaw: number;
  /** The contract price at which the suggested side is entered. */
  entryPrice: number;
}

export function sizePosition(inp: SizingInput): SizingOutput {
  const cYes = inp.yesAsk;
  const cNo = 1 - inp.yesBid; // buying NO at ask_NO = 1 - bid_YES
  const pYes = inp.pModel;
  const pNo = 1 - inp.pModel;

  let fYes = -1;
  let fNo = -1;
  if (cYes > 0.001 && cYes < 0.999) {
    fYes = (pYes - cYes) / (cYes * (1 - cYes));
  }
  if (cNo > 0.001 && cNo < 0.999) {
    fNo = (pNo - cNo) / (cNo * (1 - cNo));
  }
  const kellyRaw = Math.max(fYes, fNo);
  if (kellyRaw < 0) {
    return { action: "SKIP", positionPct: 0, kellyRaw, entryPrice: 0 };
  }
  const side: "BUY_YES" | "BUY_NO" = fYes >= fNo ? "BUY_YES" : "BUY_NO";
  const frac = Math.min(kellyRaw * inp.kellyFraction, inp.maxPositionPct);
  const entry = side === "BUY_YES" ? cYes : cNo;
  return { action: side, positionPct: frac, kellyRaw, entryPrice: entry };
}
