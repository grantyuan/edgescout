// ---------------------------------------------------------------------------
// EdgeScout — model scorecard: settled-market accuracy backtest
//
// Proves the deterministic model's predictive power by re-evaluating it on
// recently SETTLED binary markets and comparing against actual on-chain
// outcomes (indexer `winningOutcome`). The LLM is not involved anywhere —
// every number below is computed by this deterministic, unit-tested code.
//
// Algorithm (buildScorecard, deterministic given the same indexer/candle
// state):
//  1. POST a GraphQL query to the Somnia testnet indexer for the most recent
//     `limit` finalized, non-voided BTC/ETH binary markets, ordered by
//     resolvedAtTimestamp desc. Only this call may fail the whole scorecard.
//  2. Per row (newest first), skip (and count) when: voided; winningOutcome
//     missing or not 0|1; asset not BTC/ETH; expiry/tradingStart missing.
//  3. Otherwise re-run the model exactly as the live pipeline does one
//     minute before expiry:
//       - candles: the 60 one-minute bars ending at the eval minute
//         (fetchPriceOHLCV(asset, "1m", expiry-60s-59min, 60));
//       - spotAtEval: close of the LAST returned candle;
//       - vol: realizedVolAnnualized over those candles (the exact live
//         estimator), DEFAULT_VOL fallback with volSource "default";
//       - reference:
//           * strike markets (strike not "0"/"0.0"/null): raw strike is ×100
//             of the human price — resolveStrikeScale picks the scale closest
//             to spot (within 4×), else raw/100;
//           * up/down markets (strike "0"/"0.0"/null): open of the first
//             candle from the window's tradingStart.
//         A per-market fetch failure → skip that market only.
//       - pModel: modelYesProbability at secondsToExpiry = 60 with that
//         reference (strike vs openPrice), ema null.
//       - outcomeYes = winningOutcome == 0; predictedYes = pModel >= 0.5;
//         correct = predictedYes == outcomeYes.
//  4. Aggregate via summarizeEvaluated (the pure core, unit-tested):
//     hitRate = correct / evaluated; brierScore = mean((pModel - outcome)^2);
//     meanPModel. Full precision — the UI rounds for display.
//  4b. Per-asset split (summarizeByAsset): the same three statistics over the
//     BTC and ETH sub-populations, fixed order [BTC, ETH], nulls when an
//     asset has no evaluated markets. Calibration (summarizeCalibration):
//     five fixed buckets over pModel — [0,0.2), [0.2,0.4), [0.4,0.6),
//     [0.6,0.8), [0.8,1.0] (last inclusive) — each reporting count, mean
//     pModel and the empirical YES rate (calibration vs the model).
//  5. periodStartSec / periodEndSec = min/max expiry over evaluated markets.
//  6. markets = evaluated rows, most recent first, capped at 20 for the UI.
// ---------------------------------------------------------------------------

import { DEFAULT_VOL, SOMNIA_TESTNET } from "./config.ts";
import { modelYesProbability } from "./model.ts";
import { getExchange, realizedVolAnnualized } from "./market.ts";

/** One settled market re-evaluated by the deterministic model. */
export interface ScorecardMarket {
  /** Stable key: `<asset>-<expirySec>-<rawStrike|"open">`. */
  symbol: string;
  /** "BTC" | "ETH". */
  asset: string;
  /** "strike" (K-based) or "updown" (window-open based). */
  kind: "strike" | "updown";
  /** Human strike (strike markets) or window open price (up/down). */
  reference: number;
  /** Spot at evaluation time (last 1m candle close before expiry). */
  spotAtEval: number;
  /** Model P(YES) at evaluation time, 0..1. */
  pModel: number;
  /** pModel >= 0.5 (ties predict YES). */
  predictedYes: boolean;
  /** Actual outcome: winningOutcome === 0 means YES paid. */
  outcomeYes: boolean;
  /** predictedYes === outcomeYes. */
  correct: boolean;
  /** Market expiry (unix seconds). */
  expirySec: number;
}

/** Aggregate scorecard (all fields JSON-safe: numbers / bools / strings / nulls). */
export interface ScorecardSummary {
  /** Markets fully evaluated. */
  evaluated: number;
  /** Markets skipped (voided / unresolved / unresolvable / bad data). */
  skipped: number;
  /** Predictions that matched the actual outcome. */
  correct: number;
  /** correct / evaluated, null when evaluated === 0. */
  hitRate: number | null;
  /** mean((pModel - outcome)^2) with outcome 1 = YES; null when none. */
  brierScore: number | null;
  /** Mean pModel over evaluated markets; null when none. */
  meanPModel: number | null;
  /** Earliest evaluated market's expiry (unix seconds); null when none. */
  periodStartSec: number | null;
  /** Latest evaluated market's expiry (unix seconds); null when none. */
  periodEndSec: number | null;
  /** Per-asset hit-rate / Brier split, fixed order [BTC, ETH]. */
  perAsset: AssetSummary[];
  /** Five fixed calibration buckets over pModel (always 5 entries). */
  calibration: CalibrationBucket[];
  /** Evaluated rows, most recent first, capped at 20 for the UI. */
  markets: ScorecardMarket[];
}

/** Prediction rule: the model commits to the side it sees as more likely. */
export function predictsYes(pModel: number): boolean {
  return pModel >= 0.5;
}

/**
 * Resolve the strike scale: the indexer stores strikes in raw units that are
 * ×100 of the human price on this testnet (e.g. "8034190" = 80341.90). Mirror
 * market.ts's `resolveStrikes`: pick whichever of raw/100 and raw is closest
 * to spot (log distance), provided it is within a factor of 4; otherwise fall
 * back to the raw/100 convention. Degenerate spot → raw/100.
 */
export function resolveStrikeScale(raw: number, spot: number): number {
  const c100 = raw / 100;
  if (!(spot > 0) || !Number.isFinite(spot)) return c100;
  const d100 = Math.abs(Math.log(c100 / spot));
  const d1 = Math.abs(Math.log(raw / spot));
  const scaled = d100 <= d1 ? c100 : raw;
  if (Math.abs(Math.log(scaled / spot)) < Math.log(4)) return scaled;
  return c100;
}

/**
 * Pure aggregation core (unit-tested): hit rate, Brier score and mean model
 * probability over re-evaluated settled markets. Full precision — rounding
 * happens in the UI.
 */
export function summarizeEvaluated(rows: Array<{
  pModel: number;
  outcomeYes: boolean;
}>): {
  evaluated: number;
  correct: number;
  hitRate: number | null;
  brierScore: number | null;
  meanPModel: number | null;
} {
  const evaluated = rows.length;
  if (evaluated === 0) {
    return { evaluated: 0, correct: 0, hitRate: null, brierScore: null, meanPModel: null };
  }
  let correct = 0;
  let brierSum = 0;
  let pSum = 0;
  for (const r of rows) {
    const outcome = r.outcomeYes ? 1 : 0;
    if (predictsYes(r.pModel) === r.outcomeYes) correct += 1;
    brierSum += (r.pModel - outcome) ** 2;
    pSum += r.pModel;
  }
  return {
    evaluated,
    correct,
    hitRate: correct / evaluated,
    brierScore: brierSum / evaluated,
    meanPModel: pSum / evaluated,
  };
}

/** The two assets the deterministic model evaluates (matches the indexer filter). */
export const SCORECARD_ASSETS = ["BTC", "ETH"] as const;

/** Per-asset split of the aggregate hit-rate / Brier (one entry per requested asset). */
export interface AssetSummary {
  /** Asset name as requested (e.g. "BTC" | "ETH"). */
  asset: string;
  /** Evaluated markets for this asset. */
  evaluated: number;
  /** Predictions that matched the outcome. */
  correct: number;
  /** correct / evaluated; null when evaluated === 0. */
  hitRate: number | null;
  /** Mean Brier for this asset; null when evaluated === 0. */
  brierScore: number | null;
  /** Mean pModel for this asset; null when evaluated === 0. */
  meanPModel: number | null;
}

/**
 * Pure core (unit-tested): per-asset split of hit-rate / Brier. Deterministic
 * over the requested `assets` list (fixed output order = input list order);
 * rows whose asset is not in the list are ignored; assets with no rows
 * report evaluated 0 and nulls.
 */
export function summarizeByAsset(
  rows: Array<{ asset: string; pModel: number; outcomeYes: boolean }>,
  assets: readonly string[] = SCORECARD_ASSETS,
): AssetSummary[] {
  return assets.map((asset) => {
    const s = summarizeEvaluated(
      rows
        .filter((r) => r.asset === asset)
        .map((r) => ({ pModel: r.pModel, outcomeYes: r.outcomeYes })),
    );
    return { asset, ...s };
  });
}

/** One fixed-width calibration bucket over pModel. */
export interface CalibrationBucket {
  /** Label, e.g. "0.00-0.20" (last bucket "0.80-1.00" is inclusive). */
  bucket: string;
  /** Lower bound (inclusive). */
  from: number;
  /** Upper bound; exclusive, except for the last bucket (inclusive). */
  to: number;
  /** Evaluated rows falling in this bucket. */
  count: number;
  /** Mean pModel within the bucket; null when count === 0. */
  meanPModel: number | null;
  /** Fraction of YES outcomes within the bucket; null when count === 0. */
  empiricalYesRate: number | null;
}

/**
 * Pure core (unit-tested): five fixed calibration buckets over pModel —
 * [0,0.2), [0.2,0.4), [0.4,0.6), [0.6,0.8), [0.8,1.0] (the last bucket is
 * inclusive on both ends). Rows whose pModel is not finite or outside [0,1]
 * are dropped defensively. The output always contains all five buckets
 * (empty ones report count 0 and nulls), so the response shape is stable.
 */
export function summarizeCalibration(
  rows: Array<{ pModel: number; outcomeYes: boolean }>,
): CalibrationBucket[] {
  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const clean = rows.filter(
    (r) => Number.isFinite(r.pModel) && r.pModel >= 0 && r.pModel <= 1,
  );
  return edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1];
    const last = i === edges.length - 2;
    const sub = clean.filter((r) => r.pModel >= from && (last ? r.pModel <= to : r.pModel < to));
    const count = sub.length;
    let pSum = 0;
    let yes = 0;
    for (const r of sub) {
      pSum += r.pModel;
      if (r.outcomeYes) yes += 1;
    }
    return {
      bucket: `${from.toFixed(2)}-${to.toFixed(2)}`,
      from,
      to,
      count,
      meanPModel: count === 0 ? null : pSum / count,
      empiricalYesRate: count === 0 ? null : yes / count,
    };
  });
}

/** Raw indexer row shape (Hasura-style GraphQL response). */
interface IndexerRow {
  asset: string | null;
  marketType: string | null;
  strike: string | null;
  expiry: string | number | null;
  tradingStart: string | number | null;
  winningOutcome: number | string | null;
  voided: boolean | null;
  finalized: boolean | null;
  resolvedAtTimestamp: number | string | null;
}

/** Parse a unix-seconds field (string or number) → number, null when absent. */
function toUnixSec(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type Exchange = Awaited<ReturnType<typeof getExchange>>;

/**
 * Re-evaluate one settled market at the same point the live pipeline would
 * (one minute before expiry). Returns null — counting the market as skipped —
 * whenever it cannot be evaluated (voided, unresolved, unresolvable
 * reference, missing candles).
 */
async function evaluateRow(row: IndexerRow, ex: Exchange): Promise<ScorecardMarket | null> {
  if (row.voided === true) return null;
  const wo = toUnixSec(row.winningOutcome);
  if (wo !== 0 && wo !== 1) return null; // missing or not settled to a definite outcome
  const asset = row.asset;
  if (asset !== "BTC" && asset !== "ETH") return null;
  const expirySec = toUnixSec(row.expiry);
  const tradingStartSec = toUnixSec(row.tradingStart);
  if (expirySec == null || tradingStartSec == null) return null;

  try {
    const expiryMs = expirySec * 1000;
    const evalMs = expiryMs - 60_000;
    // The 60 one-minute bars ending at the eval minute.
    const candles = await ex.fetchPriceOHLCV(asset, "1m", evalMs - 59 * 60_000, 60);
    if (!candles || candles.length < 2) return null;
    const spotAtEval = Number(candles[candles.length - 1][4]);
    if (!(spotAtEval > 0) || !Number.isFinite(spotAtEval)) return null;

    let volAnnualized = realizedVolAnnualized(candles);
    let volSource: "candles" | "default" = "default";
    if (volAnnualized != null) {
      volSource = "candles";
    } else {
      volAnnualized = DEFAULT_VOL[asset] ?? 0.45;
    }

    // Reference: strike (×100 raw scale) vs window open.
    const strikeRaw = row.strike;
    const isStrike =
      strikeRaw != null && strikeRaw !== "" && strikeRaw !== "0" && strikeRaw !== "0.0";
    let kind: "strike" | "updown";
    let reference: number;
    if (isStrike) {
      const raw = Number(strikeRaw);
      if (!Number.isFinite(raw) || raw <= 0) return null;
      reference = resolveStrikeScale(raw, spotAtEval);
      kind = "strike";
    } else {
      const oc = await ex.fetchPriceOHLCV(asset, "1m", tradingStartSec * 1000, 2);
      if (!oc || oc.length === 0) return null;
      reference = Number(oc[0][1]);
      if (!(reference > 0) || !Number.isFinite(reference)) return null;
      kind = "updown";
    }

    const out = modelYesProbability({
      asset,
      spot: spotAtEval,
      ema: null,
      strike: kind === "strike" ? reference : null,
      openPrice: kind === "updown" ? reference : null,
      secondsToExpiry: 60,
      volAnnualized,
      volSource,
    });
    const pModel = out.pModel;
    const outcomeYes = wo === 0;
    const predictedYes = predictsYes(pModel);
    return {
      symbol: `${asset}-${expirySec}-${kind === "strike" ? String(strikeRaw) : "open"}`,
      asset,
      kind,
      reference,
      spotAtEval,
      pModel,
      predictedYes,
      outcomeYes,
      correct: predictedYes === outcomeYes,
      expirySec,
    };
  } catch {
    // One bad market (candle fetch / open fetch / parse) never fails the
    // whole scorecard — skip it.
    return null;
  }
}

/**
 * Build the scorecard over the most recent `limit` settled markets
 * (bounded to 8 concurrent candle fetches). Only the initial indexer query
 * may throw; any per-market failure skips that market so one bad market
 * never fails the whole scorecard.
 */
export async function buildScorecard(limit = 100): Promise<ScorecardSummary> {
  const query = `{ Market(where: { voided: { _eq: false }, finalized: { _eq: true }, asset: { _in: ["BTC", "ETH"] } }, limit: ${limit}, order_by: { resolvedAtTimestamp: desc }) { asset marketType strike expiry tradingStart winningOutcome voided finalized resolvedAtTimestamp } }`;
  let resp: Response;
  try {
    resp = await fetch(SOMNIA_TESTNET.indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(
      `scorecard: indexer query failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!resp.ok) {
    throw new Error(`scorecard: indexer HTTP ${resp.status}`);
  }
  let rows: IndexerRow[];
  try {
    const data: unknown = await resp.json();
    const market = (data as { data?: { Market?: IndexerRow[] } })?.data?.Market;
    if (!Array.isArray(market)) {
      throw new Error("unexpected response shape");
    }
    rows = market;
  } catch (e) {
    throw new Error(
      `scorecard: indexer response unparseable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const ex = await getExchange();

  // Bounded concurrency: each market needs 1-2 candle fetches. Eight in
  // flight keeps first-call latency down without hammering the testnet, and
  // chunking preserves row order so "most recent first" holds.
  const CONCURRENCY = 8;
  const results: (ScorecardMarket | null)[] = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(chunk.map((row) => evaluateRow(row, ex)))));
  }
  const evaluated = results.filter((m): m is ScorecardMarket => m !== null);
  const skipped = results.length - evaluated.length;

  const summary = summarizeEvaluated(
    evaluated.map((m) => ({ pModel: m.pModel, outcomeYes: m.outcomeYes })),
  );
  const expiries = evaluated.map((m) => m.expirySec);
  return {
    ...summary,
    skipped,
    perAsset: summarizeByAsset(
      evaluated.map((m) => ({ asset: m.asset, pModel: m.pModel, outcomeYes: m.outcomeYes })),
    ),
    calibration: summarizeCalibration(
      evaluated.map((m) => ({ pModel: m.pModel, outcomeYes: m.outcomeYes })),
    ),
    periodStartSec: evaluated.length > 0 ? Math.min(...expiries) : null,
    periodEndSec: evaluated.length > 0 ? Math.max(...expiries) : null,
    markets: evaluated.slice(0, 20),
  };
}
