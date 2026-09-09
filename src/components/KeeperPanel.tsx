"use client";

// ---------------------------------------------------------------------------
// KeeperPanel - KeeperHub Agent Economy execution status.
//
// Calls GET /api/keeperhub: whether the org API key is configured, chain,
// USDC token, stake cap, dry-run flag, the org wallet address, and the last
// five executions recorded in the paper ledger. Purely informational: any
// failure renders an error line and never breaks the dashboard.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";

interface KeeperStatus {
  ok: boolean;
  configured: boolean;
  chain: string;
  usdc: string;
  maxStakeUsd: number;
  dryRun: boolean;
  wallet: string | null;
  lastExecutions: {
    executionId: string;
    chain: string;
    amountUsd: number;
    from: string;
    to: string;
    txHash: string | null;
    txLink: string | null;
    status: "simulated" | "submitted" | "success" | "failed";
    error?: string;
    executedAt: number;
  }[];
  note?: string;
}

function truncateHex(hex: string | null, head = 8, tail = 6): string {
  if (!hex) return "—";
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function fmtTime(ms: number): string {
  const t = Number(ms);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toISOString().slice(5, 16).replace("T", " ");
}

export default function KeeperPanel() {
  const [data, setData] = useState<KeeperStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/keeperhub");
      const body = (await res.json()) as KeeperStatus & { error?: string };
      if (body?.ok) {
        setData(body);
        setError(null);
      } else {
        setData(null);
        setError(body?.error ?? `keeperhub status unavailable (HTTP ${res.status})`);
      }
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  if (loading && data == null) {
    return (
      <div className="border border-zinc-800 rounded-lg mt-4 p-4">
        <p className="text-zinc-600 text-xs animate-pulse">Checking KeeperHub status…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-zinc-800 rounded-lg mt-4 p-4">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-xs uppercase tracking-widest text-zinc-500">KeeperHub</h2>
          <span className="px-2 py-0.5 rounded text-[10px] border border-red-800 bg-red-950/40 text-red-300">ERROR</span>
        </div>
        <p className="text-red-300/80 text-[11px]">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="border border-zinc-800 rounded-lg mt-4 p-4">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-xs uppercase tracking-widest text-zinc-500">
          KeeperHub · {data.chain} execution
        </h2>
        <span
          className={`px-2 py-0.5 rounded text-[10px] border ${
            data.configured
              ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
              : "border-zinc-700 bg-zinc-800/60 text-zinc-400"
          }`}
        >
          {data.configured ? "CONNECTED" : "NOT CONFIGURED"}
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          className="ml-auto rounded border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700/60 disabled:opacity-50"
        >
          {loading ? "refreshing…" : "refresh"}
        </button>
      </div>

      {!data.configured ? (
        <p className="text-amber-300/80 text-[11px]">{data.note}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
            <div>
              <div className="text-zinc-500 text-[10px]">Org wallet</div>
              <div className="text-zinc-100 text-sm font-mono" title={data.wallet ?? ""}>
                {data.wallet ? truncateHex(data.wallet) : "—"}
              </div>
            </div>
            <div>
              <div className="text-zinc-500 text-[10px]">USDC</div>
              <div className="text-zinc-100 text-sm font-mono" title={data.usdc}>
                {truncateHex(data.usdc)}
              </div>
            </div>
            <div>
              <div className="text-zinc-500 text-[10px]">Stake cap</div>
              <div className="text-zinc-300 text-sm">{data.maxStakeUsd} USDC</div>
            </div>
            <div>
              <div className="text-zinc-500 text-[10px]">Mode</div>
              <div className="text-zinc-300 text-sm">{data.dryRun ? "dry-run" : "live"}</div>
            </div>
          </div>

          {data.lastExecutions.length > 0 && (
            <div className="space-y-1 text-[11px]">
              <div className="text-zinc-500 text-[10px] uppercase tracking-wider">Recent executions</div>
              {data.lastExecutions.map((ex) => (
                <div key={ex.executionId} className="flex gap-2">
                  <span className="text-zinc-500 w-28 shrink-0">{fmtTime(ex.executedAt)}</span>
                  <span
                    className={`w-20 shrink-0 ${
                      ex.status === "success"
                        ? "text-emerald-300"
                        : ex.status === "failed"
                          ? "text-red-300"
                          : "text-zinc-300"
                    }`}
                  >
                    {ex.status}
                  </span>
                  <span className="text-zinc-300 w-20 shrink-0">{ex.amountUsd} USDC</span>
                  {ex.txLink ? (
                    <a href={ex.txLink} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                      view on-chain
                    </a>
                  ) : (
                    <span className="text-zinc-600" title={ex.txHash ?? ex.error}>
                      {truncateHex(ex.txHash, 10, 8) ?? "(no tx)"}
                    </span>
                  )}
                  {ex.error && <span className="text-red-300/80 truncate">{ex.error}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
