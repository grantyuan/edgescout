// GET /api/analyze?symbol=<market symbol>
// Runs the agent pipeline: live board data → deterministic model → LLM narrative.
import { analyze } from "@/lib/agent";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  if (!symbol) {
    return Response.json(
      { ok: false, error: "missing ?symbol=<market symbol>" },
      { status: 400 },
    );
  }
  try {
    const { view, report } = await analyze(symbol);
    return Response.json({ ok: true, view, report });
  } catch (e) {
    console.error(
      "[analyze] failed for",
      symbol,
      ":",
      (e as Error)?.message,
      (e as Error)?.stack,
    );
    return Response.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
