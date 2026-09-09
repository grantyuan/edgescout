// GET /api/signals — signal/edge observation log summary.
// Deterministic, no LLM: how often the model saw a tradeable edge
// (|edge| >= 3pp), how large it was, the top-5 largest edges, kind mix,
// and the most recent 20 samples (written by recordBoard as the dashboard
// polls the board).
// 30s in-memory cache — the file only changes on board refreshes, so the
// cache keeps poll traffic off disk. Empty log → ok:true with zeros.
import { loadSignals, summarizeSignals, type SignalSummary } from "@/lib/signals";

const CACHE_TTL_MS = 30_000;

let cache: { at: number; data: SignalSummary } | null = null;

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      return Response.json({ ok: true, generatedAt: new Date(cache.at).toISOString(), signals: cache.data });
    }
    const file = await loadSignals();
    const data = summarizeSignals(file.observations);
    cache = { at: now, data };
    return Response.json({ ok: true, generatedAt: new Date(now).toISOString(), signals: data });
  } catch (e) {
    console.error("[signals] failed:", e);
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
