// GET /api/paper/export — download the persisted paper ledger as CSV
// (settled + open entries, deterministic column order, LF line endings).
// This is a snapshot of data/paper-ledger.json: auto-settlement runs on
// /api/paper reads, not on export, so the export never touches the network.
import { entriesToCsv, loadLedger } from "@/lib/paper";

export async function GET() {
  try {
    const file = await loadLedger();
    const csv = entriesToCsv(file.entries);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="paper-ledger.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
