// GET /api/markets — the live event-contract board (cached server-side, 10s).
import { fetchBoard } from "@/lib/market";

export async function GET() {
  try {
    const markets = await fetchBoard();
    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      markets,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: (e as Error).message },
      { status: 502 },
    );
  }
}
