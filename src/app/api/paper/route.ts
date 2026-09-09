// GET /api/paper — paper-trading account summary (auto-settles due markets,
// marks open positions with live data).
import { getAccount } from "@/lib/paper";

export async function GET() {
  try {
    const account = await getAccount();
    return Response.json({ ok: true, account });
  } catch (e) {
    return Response.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
