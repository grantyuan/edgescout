// GET /api/asc — on-chain state of EdgeScout's ASC (read-only).
//
// EdgeScoutSignalStore (contracts/src/EdgeScoutSignalStore.sol) is EdgeScout's
// own Attestcoin Smart Contract on Creditcoin CC3 testnet: it re-verifies a
// source-chain proof through the Block Prover precompile (0x0FD2) inside the
// transaction and stores the decoded fact. This route reads that state back
// with eth_call only — no wallet, no signer, no gas; writes happen exclusively
// in scripts/attest-on-asc.mjs.
//
// Before deployment (which awaits testnet funds) EDGE_SCOUT_ASC_ADDRESS is
// empty and the route answers 200 with { ok: true, deployed: false, note },
// so the dashboard renders an honest "not deployed yet" row. 60s in-memory
// cache, same pattern as /api/attest — ASC state only changes when someone
// submits a new proof.
import { getAscState, type AscState } from "@/lib/asc";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 60_000;

let cache: { at: number; data: AscState } | null = null;

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      return Response.json(cache.data);
    }
    const data = await getAscState();
    if (!data.ok) {
      // Transport/config problem (CC3 RPC down, bad address) — never cached.
      return Response.json(data, { status: 502 });
    }
    cache = { at: now, data };
    return Response.json(data);
  } catch (e) {
    console.error("[asc] failed:", e);
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
