// ---------------------------------------------------------------------------
// EdgeScout — agent report orchestration
// Combines: live board (market + book + price) → deterministic model → LLM
// narrative (or mock fallback). The LLM never invents numbers.
// ---------------------------------------------------------------------------

import { fetchBoard, getExchange, buildViewForSymbol, type MarketView } from "./market.ts";
import { generateReport, type AgentReport } from "./llm.ts";

export interface AnalyzeResult {
  view: MarketView;
  report: AgentReport;
}

/**
 * Find a market view by symbol. Prefers the warm board cache; falls back to a
 * dedicated single-market view when the board (top-N) doesn't include it.
 */
async function findView(symbol: string): Promise<MarketView> {
  const board = await fetchBoard();
  const hit = board.find((v) => v.symbol === symbol);
  if (hit) return hit;

  // Verify the market exists in the indexer, then build a dedicated view.
  const ex = await getExchange();
  const markets = await ex.loadMarkets(true);
  if (!(symbol in markets)) {
    throw new Error(`market not found on testnet: ${symbol}`);
  }
  return buildViewForSymbol(symbol);
}

const RETRY_DELAYS_MS = [800, 2000];

/**
 * Deterministic errors (unknown symbol, malformed input) are not retryable;
 * transient testnet failures (indexer latency, brief connection errors) are.
 */
function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found|unparseable|missing/i.test(msg)) return false;
  return true;
}

/** Run a network-touching step with short backoff; rethrow the last error. */
async function withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e) || i === RETRY_DELAYS_MS.length) throw e;
      console.warn(`[agent] ${what} attempt ${i + 1} failed (${(e as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    }
  }
  throw lastErr;
}

/** Full agent analysis for one market symbol. */
export async function analyze(symbol: string): Promise<AnalyzeResult> {
  const view = await withRetry(() => findView(symbol), "analyze view");
  const report = await generateReport(view);
  return { view, report };
}
