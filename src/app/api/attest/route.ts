// GET /api/attest — Attestcoin Protocol attestation check (read-only).
//
// Fetches a Merkle + continuity proof for a source-chain (Sepolia) transaction
// from the hosted proof builder and verifies it on Creditcoin CC3 testnet via
// eth_call against the Block Prover precompile (0x0FD2). No wallet, no signer,
// no gas: verification is a free static call. Optional ?txHash= overrides the
// default attested transaction. 60s in-memory cache per tx hash (same pattern
// as /api/scorecard) — attestation advances per Creditcoin block, and the
// proof fetch + eth_call take a couple of seconds.
import { getAttestation, type AttestationResult } from "@/lib/attest";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { at: number; data: AttestationResult }>();

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const txHash = searchParams.get("txHash");
  const key = txHash ?? "default";
  try {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return Response.json(hit.data);
    }
    const data = await getAttestation({ txHash });
    if (!data.ok) {
      // Upstream (proof builder / CC3 RPC) problem — never cached.
      return Response.json(data, { status: 502 });
    }
    cache.set(key, { at: now, data });
    return Response.json(data);
  } catch (e) {
    console.error("[attest] failed:", e);
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
