// POST /api/paper/open { symbol } — accept the agent's deterministic
// suggestion for a live market as a simulated fill (no chain orders).
import { buildViewForSymbol } from "@/lib/market";
import { openPosition } from "@/lib/paper";

export async function POST(request: Request) {
  let symbol = "";
  try {
    const body = (await request.json()) as { symbol?: string };
    symbol = body?.symbol ?? "";
  } catch {
    return Response.json(
      { ok: false, error: "invalid JSON body, expected { symbol }" },
      { status: 400 },
    );
  }
  if (!symbol) {
    return Response.json(
      { ok: false, error: "missing symbol" },
      { status: 400 },
    );
  }
  try {
    const view = await buildViewForSymbol(symbol);
    const account = await openPosition(view);
    return Response.json({ ok: true, account });
  } catch (e) {
    return Response.json(
      { ok: false, error: (e as Error).message },
      { status: 409 },
    );
  }
}
