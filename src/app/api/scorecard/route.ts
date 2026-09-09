// GET /api/scorecard — deterministic model accuracy backtest over recently
// settled testnet markets (indexer outcomes re-evaluated by the same model the
// live pipeline uses). No LLM involved. 60s in-memory cache; the underlying
// build is I/O-heavy (~10-30s for 100 markets, bounded concurrency), so the
// cache matters.
import { buildScorecard, type ScorecardSummary } from "@/lib/scorecard";

const CACHE_TTL_MS = 60_000;

let cache: { at: number; data: ScorecardSummary } | null = null;

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      return Response.json({ ok: true, scorecard: cache.data });
    }
    const data = await buildScorecard();
    cache = { at: now, data };
    return Response.json({ ok: true, scorecard: data });
  } catch (e) {
    console.error("[scorecard] failed:", e);
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
