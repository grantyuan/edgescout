// GET /api/chart?symbol=<market symbol>
// Latest market view + recent 1m candles for the detail chart.
import { buildViewForSymbol, fetchCandles } from "@/lib/market";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  if (!symbol) {
    return Response.json(
      { ok: false, error: "missing ?symbol=<market symbol>" },
      { status: 400 },
    );
  }
  try {
    const view = await buildViewForSymbol(symbol);
    const candles = await fetchCandles(view.asset, 90).catch(() => []);
    return Response.json({ ok: true, view, candles });
  } catch (e) {
    return Response.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
