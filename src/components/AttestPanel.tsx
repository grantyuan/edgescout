"use client";

// ---------------------------------------------------------------------------
// AttestPanel — Attestcoin Protocol attestation status.
//
// Calls GET /api/attest, which pulls a Merkle + continuity proof for a Sepolia
// transaction from the hosted proof builder and verifies it on Creditcoin CC3
// testnet with a free eth_call against the Block Prover precompile (0x0FD2).
// Purely informational: any failure renders an error line, never breaks the
// dashboard.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";

/** GET /api/asc — on-chain state of EdgeScout's own ASC (read-only). */
interface AscView {
  ok: boolean;
  deployed: boolean;
  ascAddress: string | null;
  signalCount: number | null;
  explorerUrl: string | null;
  note?: string;
}

interface AttestationView {
  ok: boolean;
  verified: boolean;
  sourceChain: { chainKey: number; chainId: number; name: string } | null;
  blockNumber: number | null;
  txHash: string;
  txIndex: number | null;
  merkleRoot: string | null;
  continuityBlocks: number | null;
  attestedHeight: number | null;
  attestationLagBlocks: number | null;
  precompile: string;
  rpcUrl: string;
  fetchedAt: string;
  error?: string;
}

/** 0x1234…cdef — keeps hashes readable in a narrow panel. */
function truncateHex(hex: string | null, head = 10, tail = 8): string {
  if (!hex) return "—";
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toISOString().slice(11, 19) + "Z";
}

function fmtNum(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

export default function AttestPanel() {
  const [data, setData] = useState<AttestationView | null>(null);
  const [asc, setAsc] = useState<AscView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    // The ASC row is informational; its failure must never affect the panel.
    void fetch("/api/asc")
      .then((res) => res.json() as Promise<AscView>)
      .then((body) => setAsc(body?.ok ? body : null))
      .catch(() => setAsc(null));
    try {
      const res = await fetch("/api/attest");
      const body = (await res.json()) as AttestationView & { error?: string };
      if (body?.ok) {
        setData(body);
        setError(null);
      } else {
        setData(null);
        setError(body?.error ?? `attestation unavailable (HTTP ${res.status})`);
      }
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Kick the first fetch off a microtask (react-hooks/set-state-in-effect).
    void Promise.resolve().then(refresh);
  }, [refresh]);

  return (
    <div className="border border-zinc-800 rounded-lg mt-4 p-4">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-xs uppercase tracking-widest text-zinc-500">
          Attestcoin Attestations · cross-chain proof
        </h2>
        <span
          className={`px-2 py-0.5 rounded text-[10px] border ${
            loading && data == null
              ? "border-zinc-700 bg-zinc-800/60 text-zinc-400"
              : data?.verified
                ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
                : "border-red-800 bg-red-950/40 text-red-300"
          }`}
        >
          {loading && data == null
            ? "CHECKING…"
            : data?.verified
              ? "VERIFIED ON-CHAIN"
              : "FAILED"}
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          className="ml-auto rounded border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700/60 disabled:opacity-50"
        >
          {loading ? "checking…" : "refresh"}
        </button>
      </div>

      {error && (
        <p className="text-red-300/80 text-[11px] mb-2">
          attestation unavailable: {error}
        </p>
      )}

      {data == null ? (
        !error && (
          <p className="text-zinc-600 text-xs animate-pulse">
            proving a Sepolia transaction on Creditcoin CC3 (proof fetch → eth_call)…
          </p>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
            <div>
              <div className="text-zinc-500 text-[10px]">Source chain</div>
              <div className="text-zinc-100 text-sm font-semibold">
                {data.sourceChain?.name ?? "—"}
                <span className="text-zinc-600 text-[10px] ml-1">
                  key {data.sourceChain?.chainKey ?? "—"}
                </span>
              </div>
            </div>
            <div>
              <div className="text-zinc-500 text-[10px]">Attested height</div>
              <div className="text-sky-300 text-sm font-semibold">
                {fmtNum(data.attestedHeight)}
              </div>
            </div>
            <div>
              <div className="text-zinc-500 text-[10px]">Proven block</div>
              <div className="text-zinc-100 text-sm font-semibold">
                {fmtNum(data.blockNumber)}
                <span className="text-zinc-600 text-[10px] ml-1">
                  tx #{data.txIndex ?? "—"}
                </span>
              </div>
            </div>
            <div>
              <div className="text-zinc-500 text-[10px]">Continuity proof</div>
              <div className="text-zinc-300 text-sm">
                {fmtNum(data.continuityBlocks)}
                <span className="text-zinc-600 text-[10px] ml-1">block roots</span>
              </div>
            </div>
          </div>

          <div className="space-y-1 text-[11px]">
            <div className="flex gap-2">
              <span className="text-zinc-500 w-24 shrink-0">Source tx</span>
              <span className="text-zinc-300 font-mono" title={data.txHash}>
                {truncateHex(data.txHash, 12, 10)}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-zinc-500 w-24 shrink-0">Merkle root</span>
              <span className="text-zinc-300 font-mono" title={data.merkleRoot ?? ""}>
                {truncateHex(data.merkleRoot, 12, 10)}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-zinc-500 w-24 shrink-0">On-chain ASC</span>
              <span className="text-zinc-400" title={asc?.ascAddress ?? asc?.note ?? ""}>
                {asc == null ? (
                  "—"
                ) : asc.deployed ? (
                  <>
                    <span className="text-emerald-300">
                      {fmtNum(asc.signalCount)} verified fact
                      {asc.signalCount === 1 ? "" : "s"} stored
                    </span>
                    <span className="text-zinc-600 ml-1 font-mono">
                      {truncateHex(asc.ascAddress, 8, 6)}
                    </span>
                  </>
                ) : (
                  <span className="text-amber-300/80">
                    not deployed yet (testnet funds pending)
                  </span>
                )}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-zinc-500 w-24 shrink-0">Verifier</span>
              <span className="text-zinc-400 font-mono" title={data.precompile}>
                {truncateHex(data.precompile, 10, 6)}
                <span className="text-zinc-600 ml-1">
                  block prover precompile · eth_call
                </span>
              </span>
            </div>
          </div>

          <p className="text-zinc-600 text-[10px] mt-2">
            Checked {fmtTime(data.fetchedAt)} · the proof builder serves the Merkle +
            continuity proof, Creditcoin&apos;s attestor set signs the source block, and
            the precompile re-checks both in a free read-only call — no keys, no funds,
            no on-chain writes.
          </p>
        </>
      )}
    </div>
  );
}
