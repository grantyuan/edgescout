"use client";

// ---------------------------------------------------------------------------
// EdgeScout — Signal history panel.
// Renders the measured edge-observation log from GET /api/signals:
// edge rate, top-5 largest edges, and the most recent 20 samples.
// Polls every 15s (server caches 30s); never breaks the page when the
// endpoint is unavailable.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

type EdgeKind = "aligned" | "yes-underpriced" | "yes-overpriced" | "n/a";

interface SignalTopEdge {
  symbol: string;
  asset: string;
  edge: number;
  edgeKind: EdgeKind;
  atMs: number;
}

interface SignalObservation {
  atMs: number;
  symbol: string;
  asset: string;
  upDown: boolean;
  secondsToExpiry: number;
  pModel: number;
  pImplied: number | null;
  edge: number | null;
  edgeKind: EdgeKind;
  spot: number | null;
}

interface SignalSummary {
  total: number;
  markets: number;
  periodStartMs: number | null;
  periodEndMs: number | null;
  withBook: number;
  edgeGe3pp: number;
  edgeRate: number | null;
  meanAbsEdge: number | null;
  maxAbsEdge: number | null;
  maxAbsEdgeSymbol: string | null;
  kindCounts: {
    aligned: number;
    yesUnderpriced: number;
    yesOverpriced: number;
    noBook: number;
  };
  topEdges: SignalTopEdge[];
  recent: SignalObservation[];
}

function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toISOString().slice(5, 16).replace("T", " ");
}

function fmtPct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

function fmtPp(x: number | null, digits = 2): string {
  return x == null ? "—" : `${(x * 100).toFixed(digits)}pp`;
}

/** Same coloring semantics as the market wall's edge column. */
function edgeCell(edge: number | null, kind: EdgeKind) {
  if (edge == null) return <span className="text-zinc-500">n/a</span>;
  const pp = (edge * 100).toFixed(1);
  if (kind === "yes-underpriced")
    return <span className="text-emerald-400 font-semibold">+{pp}pp YES</span>;
  if (kind === "yes-overpriced")
    return <span className="text-amber-400 font-semibold">{pp}pp NO</span>;
  return <span className="text-zinc-400">{pp}pp ±</span>;
}

export default function SignalHistoryPanel() {
  const [summary, setSummary] = useState<SignalSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/signals")
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (d && d.ok) {
            setSummary(d.signals as SignalSummary);
            setFailed(false);
          } else {
            setFailed(true);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    // Initial load in a microtask: keeps setState out of the effect body's
    // synchronous portion (react-hooks/set-state-in-effect).
    void Promise.resolve().then(load);
    const t = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const header = (
    <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">
      Signal history · measured edge observations
    </h2>
  );

  if (failed && summary == null) {
    return (
      <div className="border border-zinc-800 rounded-lg mt-4 p-4">
        {header}
        <p className="text-zinc-600 text-xs">signal history unavailable</p>
      </div>
    );
  }

  if (summary == null) {
    return (
      <div className="border border-zinc-800 rounded-lg mt-4 p-4">
        {header}
        <p className="text-zinc-600 text-xs animate-pulse">loading…</p>
      </div>
    );
  }

  const kc = summary.kindCounts;

  return (
    <div className="border border-zinc-800 rounded-lg mt-4 p-4">
      {header}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
        <div>
          <div className="text-zinc-500 text-[10px]">Edge rate (|edge| ≥ 3pp)</div>
          <div className="text-emerald-400 text-sm font-semibold">
            {fmtPct(summary.edgeRate)}
            <span className="text-zinc-600 text-[10px] ml-1">
              {summary.edgeGe3pp}/{summary.withBook} book rows
            </span>
          </div>
        </div>
        <div>
          <div className="text-zinc-500 text-[10px]">Mean |edge|</div>
          <div className="text-zinc-100 text-sm font-semibold">
            {fmtPp(summary.meanAbsEdge)}
          </div>
        </div>
        <div>
          <div className="text-zinc-500 text-[10px]">Max |edge|</div>
          <div className="text-zinc-100 text-sm font-semibold">
            {fmtPp(summary.maxAbsEdge)}
            <span className="text-zinc-600 text-[10px] ml-1">
              {summary.maxAbsEdgeSymbol ?? ""}
            </span>
          </div>
        </div>
        <div>
          <div className="text-zinc-500 text-[10px]">Window</div>
          <div className="text-zinc-300 text-xs">
            {summary.periodStartMs == null || summary.periodEndMs == null
              ? "—"
              : `${fmtMs(summary.periodStartMs)} → ${fmtMs(summary.periodEndMs)}`}
            <span className="text-zinc-600 text-[10px] ml-1">
              {summary.markets} markets · {summary.total} samples
            </span>
          </div>
        </div>
      </div>

      {summary.total > 0 && (
        <div className="text-zinc-600 text-[10px] mb-3">
          kind mix: aligned {kc.aligned} · YES underpriced {kc.yesUnderpriced} · YES
          overpriced {kc.yesOverpriced} · no book {kc.noBook}
        </div>
      )}

      {summary.topEdges.length > 0 && (
        <div className="mb-3">
          <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
            Top 5 largest edges (full window)
          </div>
          <table className="w-full text-[11px]">
            <thead className="text-zinc-500">
              <tr className="text-left">
                <th className="py-1 pr-3">#</th>
                <th className="py-1 pr-3">Market</th>
                <th className="py-1 pr-3">Edge</th>
                <th className="py-1 pr-3">Kind</th>
                <th className="py-1">Sampled (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {summary.topEdges.map((t, i) => (
                <tr key={`${t.symbol}-${t.atMs}-${i}`} className="border-t border-zinc-800/60">
                  <td className="py-1 pr-3 text-zinc-500">{i + 1}</td>
                  <td className="py-1 pr-3 text-zinc-300">{t.symbol}</td>
                  <td className="py-1 pr-3">{edgeCell(t.edge, t.edgeKind)}</td>
                  <td className="py-1 pr-3 text-zinc-400">{t.edgeKind}</td>
                  <td className="py-1 text-zinc-500">{fmtMs(t.atMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.recent.length > 0 ? (
        <div>
          <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
            Recent samples (newest first)
          </div>
          <table className="w-full text-[11px]">
            <thead className="text-zinc-500">
              <tr className="text-left">
                <th className="py-1 pr-3">Time (UTC)</th>
                <th className="py-1 pr-3">Market</th>
                <th className="py-1 pr-3">Model</th>
                <th className="py-1 pr-3">Implied</th>
                <th className="py-1 pr-3">Edge</th>
                <th className="py-1">Kind</th>
              </tr>
            </thead>
            <tbody>
              {summary.recent.map((r, i) => (
                <tr key={`${r.atMs}-${r.symbol}-${i}`} className="border-t border-zinc-800/60">
                  <td className="py-1 pr-3 text-zinc-500">{fmtMs(r.atMs)}</td>
                  <td className="py-1 pr-3 text-zinc-300">{r.symbol}</td>
                  <td className="py-1 pr-3 text-sky-300">{fmtPct(r.pModel)}</td>
                  <td className="py-1 pr-3">{fmtPct(r.pImplied)}</td>
                  <td className="py-1 pr-3">{edgeCell(r.edge, r.edgeKind)}</td>
                  <td className="py-1 text-zinc-400">{r.edgeKind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-zinc-600 text-xs">
          No samples yet — the log records ≤1 sample per market per minute as the board
          refreshes.
        </p>
      )}

      <p className="text-zinc-600 text-[10px] mt-2">
        Sampled from every board refresh (≤1 per market per 60s), ring-buffered at 2000
        rows in data/signal-history.json.
      </p>
    </div>
  );
}
