"use client";

// ---------------------------------------------------------------------------
// EdgeScout — dashboard: live event-contract market wall + AI analyst report.
// Polls /api/markets every 15s; clicking a row runs the agent (/api/analyze).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import CandleChart, { type Candle } from "@/components/CandleChart";
import AttestPanel from "@/components/AttestPanel";
import KeeperPanel from "@/components/KeeperPanel";
import SignalHistoryPanel from "@/components/SignalHistoryPanel";

interface BookTop {
  yesBid: number | null;
  yesAsk: number | null;
  depth: number;
  timestamp: number | null;
  bids?: [number, number][];
  asks?: [number, number][];
}

interface MarketView {
  symbol: string;
  asset: string;
  strike: number | null;
  strikeLabel: string;
  upDown: boolean;
  expiresAt: string;
  secondsToExpiry: number;
  active: boolean;
  book: BookTop;
  pImplied: number | null;
  model: {
    pModel: number;
    dSigma: number;
    volAnnualized: number;
    volSource: "candles" | "default";
  };
  edge: number | null;
  edgeKind: "aligned" | "yes-underpriced" | "yes-overpriced" | "n/a";
  risk: number | null;
  suggestion: {
    action: "SKIP" | "BUY_YES" | "BUY_NO";
    positionPct: number;
    kellyRaw: number;
    entryPrice: number;
  } | null;
  openPrice: number | null;
  question: string | null;
  spot: number | null;
  ema: number | null;
}

interface AgentReport {
  headline: string;
  thesis: string;
  key_signals: string[];
  risks: string[];
  verdict: string;
  confidence: number;
  position_advice: {
    action: "SKIP" | "BUY_YES" | "BUY_NO";
    positionPct: number;
    entryPrice: number;
    rationale: string;
  };
  source: "llm" | "mock";
}

interface Health {
  llm: { mode: string; model?: string };
  network: string;
}

interface LedgerEntryT {
  id: string;
  symbol: string;
  asset: string;
  side: "YES" | "NO";
  stakePct: number;
  stake: number;
  shares: number;
  entryPrice: number;
  openAt: number;
  expiresAtMs: number;
  status: "open" | "settled";
  closeAt: number | null;
  win: boolean | null;
  pnl: number | null;
  keeperhub?: {
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
  } | null;
}

interface ScorecardSummary {
  evaluated: number;
  skipped: number;
  correct: number;
  hitRate: number | null;
  brierScore: number | null;
  meanPModel: number | null;
  periodStartSec: number | null;
  periodEndSec: number | null;
  perAsset: {
    asset: string;
    evaluated: number;
    correct: number;
    hitRate: number | null;
    brierScore: number | null;
    meanPModel: number | null;
  }[];
  calibration: {
    bucket: string;
    from: number;
    to: number;
    count: number;
    meanPModel: number | null;
    empiricalYesRate: number | null;
  }[];
  markets: {
    symbol: string;
    asset: string;
    kind: "strike" | "updown";
    reference: number;
    spotAtEval: number;
    pModel: number;
    predictedYes: boolean;
    outcomeYes: boolean;
    correct: boolean;
    expirySec: number;
  }[];
}

interface PaperAccount {
  startingBalance: number;
  balance: number;
  totalPnl: number;
  wins: number;
  losses: number;
  winRate: number | null;
  open: { entry: LedgerEntryT; unrealizedPnl: number; markValue: number }[];
  settled: LedgerEntryT[];
}

function fmtPct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

function fmtPrice(x: number | null): string {
  return x == null ? "—" : x.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "expired";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

/** Unix seconds → "MM-DD HH:mm" (UTC), for the scorecard period display. */
function fmtUnixSec(sec: number | null): string {
  if (sec == null) return "—";
  return new Date(sec * 1000).toISOString().slice(5, 16).replace("T", " ");
}

function edgeBadge(kind: MarketView["edgeKind"], edge: number | null) {
  if (kind === "n/a" || edge == null) return <span className="text-zinc-500">n/a</span>;
  const pp = (edge * 100).toFixed(1);
  if (kind === "yes-underpriced")
    return <span className="text-emerald-400 font-semibold">+{pp}pp YES</span>;
  if (kind === "yes-overpriced")
    return <span className="text-amber-400 font-semibold">{pp}pp NO</span>;
  return <span className="text-zinc-500">{pp}pp ±</span>;
}

function actionBadge(action: string | null) {
  if (action == null) return <span className="text-zinc-600">—</span>;
  const cls =
    action === "BUY_YES"
      ? "bg-emerald-900/60 text-emerald-300 border-emerald-700"
      : action === "BUY_NO"
        ? "bg-amber-900/60 text-amber-300 border-amber-700"
        : "bg-zinc-800 text-zinc-400 border-zinc-700";
  return <span className={`px-1.5 py-0.5 rounded text-xs border ${cls}`}>{action}</span>;
}

export default function Home() {
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<AgentReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [paper, setPaper] = useState<PaperAccount | null>(null);
  const [opening, setOpening] = useState(false);
  const [chart, setChart] = useState<Candle[] | null>(null);
  const [scorecard, setScorecard] = useState<ScorecardSummary | null>(null);
  const [scorecardError, setScorecardError] = useState(false);
  // Ticking clock for the paper-position countdown (avoids impure Date.now() in render).
  const [now, setNow] = useState(0);

  const refreshPaper = useCallback(async () => {
    try {
      const res = await fetch("/api/paper");
      const data = await res.json();
      if (data.ok) setPaper(data.account as PaperAccount);
    } catch {
      // paper panel is optional decoration; never break the page for it
    }
  }, []);

  // Model accuracy over settled markets (/api/scorecard, 60s server cache; first call ~10-30s).
  const refreshScorecard = useCallback(async () => {
    try {
      const res = await fetch("/api/scorecard");
      const data = await res.json();
      if (data.ok) {
        setScorecard(data.scorecard as ScorecardSummary);
        setScorecardError(false);
      } else {
        setScorecardError(true);
      }
    } catch {
      setScorecardError(true);
    }
  }, []);

  const acceptSuggestion = useCallback(async (symbol: string) => {
    setOpening(true);
    try {
      const res = await fetch("/api/paper/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const data = await res.json();
      if (data.ok) setPaper(data.account as PaperAccount);
      else setError(data.error ?? "paper open failed");
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setOpening(false);
    }
  }, []);

  const [executing, setExecuting] = useState<string | null>(null);

  const executeOnChain = useCallback(
    async (symbol: string) => {
      setExecuting(symbol);
      try {
        const res = await fetch("/api/keeperhub", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol, mode: "execute" }),
        });
        const data = await res.json();
        if (data.ok) {
          await refreshPaper();
          setError(null);
        } else {
          setError(`KeeperHub execution failed: ${data.error ?? `HTTP ${res.status}`}`);
        }
      } catch (e2) {
        setError(String((e2 as Error).message));
      } finally {
        setExecuting(null);
      }
    },
    [refreshPaper],
  );

  const refreshBoard = useCallback(async () => {
    try {
      const res = await fetch("/api/markets");
      const data = await res.json();
      if (data.ok) {
        setMarkets(data.markets as MarketView[]);
        setError(null);
      } else {
        setError(data.error ?? "unknown error");
      }
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial load in a microtask: keeps setState out of the effect body's
    // synchronous portion (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => {
      refreshBoard();
      refreshPaper();
      refreshScorecard();
    });
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    const t = setInterval(() => {
      refreshBoard();
      refreshPaper();
      refreshScorecard();
    }, 15000);
    return () => clearInterval(t);
  }, [refreshBoard, refreshPaper, refreshScorecard]);

  // 1s tick driving the paper-position expiry countdown (avoids impure
  // Date.now() during render; refreshes on the 15s poll as well).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const analyze = useCallback(async (symbol: string) => {
    setSelected(symbol);
    setAnalyzing(true);
    setReport(null);
    try {
      const res = await fetch(`/api/analyze?symbol=${encodeURIComponent(symbol)}`);
      const data = await res.json();
      if (data.ok) {
        setReport(data.report as AgentReport);
      } else {
        setError(data.error ?? "analyze failed");
      }
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setAnalyzing(false);
    }
  }, []);

  // Fetch the price chart whenever a new report lands.
  useEffect(() => {
    if (!report || !selected) return;
    let cancelled = false;
    fetch(`/api/chart?symbol=${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.ok) setChart(data.candles as Candle[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [report, selected]);

  const selView = markets.find((m) => m.symbol === selected) ?? null;

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-200 font-mono text-sm">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center gap-6 sticky top-0 bg-zinc-950/95 backdrop-blur z-10">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-white">
            EdgeScout
            <span className="text-zinc-500 font-normal text-xs ml-2">
              AI analyst for DreamDEX event contracts
            </span>
          </h1>
          <div className="text-xs text-zinc-500 mt-0.5">
            {health?.network ?? "somnia-testnet"} · {markets.length} binary markets
            {selView?.spot != null && (
              <>
                {" "}
                · BTC {fmtPrice(selView.spot)} · ETH{" "}
                {fmtPrice(markets.find((m) => m.asset === "ETH")?.spot ?? null)}
              </>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {health && (
            <span
              className={`px-2 py-0.5 rounded text-xs border ${
                health.llm.mode === "live"
                  ? "border-emerald-700 text-emerald-300 bg-emerald-900/40"
                  : "border-zinc-700 text-zinc-400 bg-zinc-800/60"
              }`}
            >
              {health.llm.mode === "live"
                ? `LLM: ${health.llm.model ?? "live"}`
                : "LLM: mock (template)"}
            </span>
          )}
          <span className="px-2 py-0.5 rounded text-xs border border-zinc-700 text-zinc-400 bg-zinc-800/60">
            testnet · paper trading
          </span>
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-4 px-3 py-2 rounded border border-red-800 bg-red-950/40 text-red-300 text-xs">
          data layer error: {error}
        </div>
      )}

      <main className="p-6 grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6">
        {/* Market wall */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">
            Event contracts · binary Up/Down · live book + model edge
          </h2>
          <div className="border border-zinc-800 rounded-lg overflow-auto max-h-[calc(100vh-180px)]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
                <tr className="text-left">
                  <th className="px-3 py-2">market</th>
                  <th className="px-3 py-2">window</th>
                  <th className="px-3 py-2">reference</th>
                  <th className="px-3 py-2">yes bid/ask</th>
                  <th className="px-3 py-2">implied</th>
                  <th className="px-3 py-2">model</th>
                  <th className="px-3 py-2">edge</th>
                  <th className="px-3 py-2">risk</th>
                  <th className="px-3 py-2">paper</th>
                </tr>
              </thead>
              <tbody>
                {loading && markets.length === 0 && (
                  <>
                    {Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="border-t border-zinc-800/70">
                        <td colSpan={9} className="px-3 py-2">
                          <div
                            className="h-3 rounded bg-zinc-800/70 animate-pulse"
                            style={{ width: `${88 - i * 7}%` }}
                          />
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={9} className="px-3 py-2 text-center text-zinc-600 text-[10px]">
                        loading live markets…
                      </td>
                    </tr>
                  </>
                )}
                {!loading && markets.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-zinc-500">
                      No active markets — testnet windows (5m/15m) rotate fast. The page auto-refreshes every 15s; hang on a moment.
                    </td>
                  </tr>
                )}
                {markets.map((m) => (
                  <tr
                    key={m.symbol}
                    onClick={() => analyze(m.symbol)}
                    className={`border-t border-zinc-800/70 cursor-pointer hover:bg-zinc-900/70 ${
                      selected === m.symbol ? "bg-zinc-900" : ""
                    }`}
                  >
                    <td className="px-3 py-2">
                      <div className="text-zinc-100">{m.asset}</div>
                      <div
                        className="text-zinc-600 text-[10px] truncate max-w-[160px]"
                        title={m.question ?? m.symbol}
                      >
                        {m.symbol}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-zinc-400">
                      {fmtCountdown(m.secondsToExpiry)}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">
                      {m.upDown ? (
                        <>
                          OPEN {fmtPrice(m.openPrice ?? m.ema)}
                        </>
                      ) : (
                        <>
                          K {fmtPrice(m.strike)}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-400">
                      {fmtPrice(m.book.yesBid)} / {fmtPrice(m.book.yesAsk)}
                      <div className="text-[10px] text-zinc-600">depth {m.book.depth}</div>
                    </td>
                    <td className="px-3 py-2">{fmtPct(m.pImplied)}</td>
                    <td className="px-3 py-2 text-sky-300">{fmtPct(m.model.pModel)}</td>
                    <td className="px-3 py-2">{edgeBadge(m.edgeKind, m.edge)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          m.risk != null && m.risk > 60
                            ? "text-red-400"
                            : m.risk != null && m.risk > 35
                              ? "text-amber-400"
                              : "text-emerald-400"
                        }
                      >
                        {m.risk ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2">{actionBadge(m.suggestion?.action ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Model scorecard — settled-market accuracy backtest */}
          <div className="border border-zinc-800 rounded-lg mt-4 p-4">
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">
              Model Scorecard · settled-market accuracy
            </h2>
            {scorecardError ? (
              <p className="text-zinc-600 text-xs">scorecard unavailable</p>
            ) : scorecard == null ? (
              <p className="text-zinc-600 text-xs animate-pulse">
                computing… (first call fetches the last ~100 settled markets’ candles, ~10-30s)
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
                  <div>
                    <div className="text-zinc-500 text-[10px]">Evaluated</div>
                    <div className="text-zinc-100 text-sm font-semibold">
                      {scorecard.evaluated}
                      <span className="text-zinc-600 text-[10px] ml-1">
                        skipped {scorecard.skipped}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-500 text-[10px]">Hit-rate</div>
                    <div className="text-sky-300 text-sm font-semibold">
                      {scorecard.hitRate == null
                        ? "—"
                        : `${(scorecard.hitRate * 100).toFixed(1)}%`}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-500 text-[10px]">Brier score</div>
                    <div className="text-zinc-100 text-sm font-semibold">
                      {scorecard.brierScore == null
                        ? "—"
                        : scorecard.brierScore.toFixed(3)}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-500 text-[10px]">Period</div>
                    <div className="text-zinc-300 text-xs">
                      {scorecard.periodStartSec == null ||
                      scorecard.periodEndSec == null
                        ? "—"
                        : `${fmtUnixSec(scorecard.periodStartSec)} → ${fmtUnixSec(scorecard.periodEndSec)}`}
                    </div>
                  </div>
                </div>
                {scorecard.markets.length > 0 ? (
                  <table className="w-full text-[11px]">
                    <thead className="text-zinc-500">
                      <tr className="text-left">
                        <th className="py-1 pr-3">Asset</th>
                        <th className="py-1 pr-3">Type</th>
                        <th className="py-1 pr-3">P(YES)</th>
                        <th className="py-1 pr-3">Model call</th>
                        <th className="py-1 pr-3">Outcome</th>
                        <th className="py-1">Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scorecard.markets.slice(0, 10).map((m, i) => (
                        <tr key={i} className="border-t border-zinc-800/60">
                          <td className="py-1 pr-3 text-zinc-100">{m.asset}</td>
                          <td className="py-1 pr-3 text-zinc-400">{m.kind}</td>
                          <td className="py-1 pr-3 text-sky-300">
                            {m.pModel.toFixed(3)}
                          </td>
                          <td className="py-1 pr-3 text-zinc-400">
                            {m.predictedYes ? "YES" : "NO"}
                          </td>
                          <td className="py-1 pr-3 text-zinc-400">
                            {m.outcomeYes ? "YES" : "NO"}
                          </td>
                          <td
                            className={`py-1 ${
                              m.correct ? "text-emerald-400" : "text-red-400"
                            }`}
                          >
                            {m.correct ? "✓" : "✗"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-zinc-600 text-xs">no settled markets yet</p>
                )}
                {Array.isArray(scorecard.perAsset) && Array.isArray(scorecard.calibration) ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    <div>
                      <h3 className="text-zinc-500 text-[10px] uppercase tracking-widest mb-1">
                        Per-asset (hit-rate / Brier)
                      </h3>
                      <table className="w-full text-[11px]">
                        <thead className="text-zinc-500">
                          <tr className="text-left">
                            <th className="py-1 pr-3">Asset</th>
                            <th className="py-1 pr-3">n</th>
                            <th className="py-1 pr-3">Hit-rate</th>
                            <th className="py-1">Brier</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scorecard.perAsset.map((a) => (
                            <tr key={a.asset} className="border-t border-zinc-800/60">
                              <td className="py-1 pr-3 text-zinc-100">{a.asset}</td>
                              <td className="py-1 pr-3 text-zinc-400">{a.evaluated}</td>
                              <td className="py-1 pr-3 text-sky-300">
                                {fmtPct(a.hitRate)}
                              </td>
                              <td className="py-1 text-zinc-100">
                                {a.brierScore == null ? "—" : a.brierScore.toFixed(3)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <h3 className="text-zinc-500 text-[10px] uppercase tracking-widest mb-1">
                        Calibration (mean P(YES) vs empirical rate)
                      </h3>
                      <table className="w-full text-[11px]">
                        <thead className="text-zinc-500">
                          <tr className="text-left">
                            <th className="py-1 pr-3">P(YES) bucket</th>
                            <th className="py-1 pr-3">n</th>
                            <th className="py-1 pr-3">mean P</th>
                            <th className="py-1">emp. rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scorecard.calibration.map((b) => (
                            <tr key={b.bucket} className="border-t border-zinc-800/60">
                              <td className="py-1 pr-3 text-zinc-300">{b.bucket}</td>
                              <td className="py-1 pr-3 text-zinc-400">{b.count}</td>
                              <td className="py-1 pr-3 text-sky-300">
                                {b.meanPModel == null ? "—" : b.meanPModel.toFixed(3)}
                              </td>
                              <td className="py-1 text-zinc-100">
                                {b.empiricalYesRate == null
                                  ? "—"
                                  : `${(b.empiricalYesRate * 100).toFixed(1)}%`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
                <p className="text-zinc-600 text-[10px] mt-2">
                  The deterministic model is re-run 1 minute before expiry on the 100 most
                  recently settled markets (measured volatility) and compared with the real
                  on-chain outcomes — hit-rate = directional accuracy, Brier = calibration.
                  Per-asset split (BTC vs ETH) and five fixed pModel calibration buckets
                  below are computed by the same unit-tested deterministic core.
                </p>
              </>
            )}
          </div>

          {/* Signal history — measured edge observations from GET /api/signals */}
          <SignalHistoryPanel />

          {/* Attestcoin Protocol — cross-chain attestation status */}
          <AttestPanel />

          {/* KeeperHub — Agent Economy on-chain execution */}
          <KeeperPanel />

          {/* Paper account */}
          {paper && (
            <div className="border border-zinc-800 rounded-lg mt-4 p-4">
              <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-3">
                Paper account (simulated — no on-chain orders)
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
                <div>
                  <div className="text-zinc-500 text-[10px]">Balance (tUSDC)</div>
                  <div className="text-zinc-100 text-sm font-semibold">
                    {paper.balance.toLocaleString("en-US")}
                    <span className="text-zinc-600 text-[10px] ml-1">
                      start {paper.startingBalance.toLocaleString("en-US")}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500 text-[10px]">Realized P&amp;L</div>
                  <div
                    className={`text-sm font-semibold ${
                      paper.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {paper.totalPnl >= 0 ? "+" : ""}
                    {paper.totalPnl.toLocaleString("en-US")}
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500 text-[10px]">Settled W/L</div>
                  <div className="text-zinc-300 text-sm">
                    {paper.wins} / {paper.losses}
                    <span className="text-zinc-600 text-[10px] ml-1">
                      win rate{" "}
                      {paper.winRate == null ? "—" : `${(paper.winRate * 100).toFixed(0)}%`}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500 text-[10px]">Open positions</div>
                  <div className="text-zinc-300 text-sm">{paper.open.length}</div>
                </div>
              </div>

              {paper.open.length > 0 && (
                <table className="w-full text-[11px]">
                  <thead className="text-zinc-500">
                    <tr className="text-left">
                      <th className="py-1 pr-3">Market</th>
                      <th className="py-1 pr-3">Side</th>
                      <th className="py-1 pr-3">Entry</th>
                      <th className="py-1 pr-3">Stake</th>
                      <th className="py-1 pr-3">uPnL</th>
                      <th className="py-1 pr-3">Expiry</th>
                      <th className="py-1">On-chain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paper.open.map((p) => (
                      <tr key={p.entry.id} className="border-t border-zinc-800/60">
                        <td className="py-1 pr-3 text-zinc-300">{p.entry.symbol}</td>
                        <td className="py-1 pr-3">{actionBadge(p.entry.side)}</td>
                        <td className="py-1 pr-3 text-zinc-400">
                          {p.entry.entryPrice.toFixed(3)}
                        </td>
                        <td className="py-1 pr-3 text-zinc-400">
                          {p.entry.stake.toLocaleString("en-US")}
                        </td>
                        <td
                          className={`py-1 pr-3 ${
                            p.unrealizedPnl >= 0
                              ? "text-emerald-400"
                              : "text-red-400"
                          }`}
                        >
                          {p.unrealizedPnl >= 0 ? "+" : ""}
                          {p.unrealizedPnl.toFixed(2)}
                        </td>
                        <td className="py-1 text-zinc-500">
                          {now > 0
                            ? fmtCountdown(
                                Math.round((p.entry.expiresAtMs - now) / 1000),
                              )
                            : "…"}
                        </td>
                        <td className="py-1">
                          {p.entry.keeperhub?.txLink ? (
                            <a
                              href={p.entry.keeperhub.txLink}
                              target="_blank"
                              rel="noreferrer"
                              className="text-emerald-300 hover:underline"
                            >
                              tx · {p.entry.keeperhub.status}
                            </a>
                          ) : (
                            <button
                              onClick={() => executeOnChain(p.entry.symbol)}
                              disabled={executing != null}
                              className="rounded border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700/60 disabled:opacity-50"
                            >
                              {executing === p.entry.symbol
                                ? "executing…"
                                : "execute on-chain via KeeperHub"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {paper.settled.length > 0 && (
                <div className="mt-3">
                  <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
                    Settled
                  </div>
                  <table className="w-full text-[11px]">
                    <tbody>
                      {paper.settled.slice(0, 8).map((e) => (
                        <tr key={e.id} className="border-t border-zinc-800/60">
                          <td className="py-1 pr-3 text-zinc-400">{e.symbol}</td>
                          <td className="py-1 pr-3">{actionBadge(e.side)}</td>
                          <td className="py-1 pr-3 text-zinc-400">
                            {e.win ? "✓ W" : "✗ L"}
                          </td>
                          <td
                            className={`py-1 ${
                              (e.pnl ?? 0) >= 0
                                ? "text-emerald-400"
                                : "text-red-400"
                            }`}
                          >
                            {(e.pnl ?? 0) >= 0 ? "+" : ""}
                            {(e.pnl ?? 0).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Report panel */}
        <section className="border border-zinc-800 rounded-lg p-4 h-fit xl:sticky xl:top-24">
          <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-3">
            Agent report
          </h2>
          {!selected && (
            <p className="text-zinc-500 text-xs leading-6">
              Click any market on the left: the Agent pulls the live book + price signals,
              runs the deterministic probability model (zero-drift Brownian motion +
              measured volatility), compares it with the implied probability of the
              order book to surface an edge, then the LLM writes the analyst report.
            </p>
          )}
          {selected && analyzing && (
            <div className="text-zinc-400 text-xs animate-pulse">
              Analyzing {selected} … (book/price → model → LLM)
            </div>
          )}
          {report && selView && (
            <div className="space-y-4 text-xs leading-6">
              <div>
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
                  {selView.symbol}
                </div>
                <div className="text-zinc-100 text-sm font-semibold">{report.headline}</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded border border-sky-800 bg-sky-950/40 text-sky-300">
                    {report.verdict}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded border text-[10px] ${
                      report.source === "llm"
                        ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
                        : "border-zinc-700 bg-zinc-800/60 text-zinc-400"
                    }`}
                  >
                    {report.source === "llm" ? "LLM" : "mock template"}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-zinc-500">Confidence</span>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded">
                  <div
                    className="h-full rounded bg-sky-500"
                    style={{ width: `${report.confidence}%` }}
                  />
                </div>
                <span className="text-sky-300">{report.confidence}</span>
              </div>

              {/* Chart + depth ladder */}
              <div>
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
                  {selView.asset} 1m candles (last 90 min) + settlement reference
                </div>
                <CandleChart
                  candles={chart ?? []}
                  refPrice={selView.upDown ? (selView.openPrice ?? selView.ema) : selView.strike}
                  refLabel={selView.upDown ? "OPEN" : "STRIKE"}
                />
                {(selView.book.bids?.length ?? 0) > 0 || (selView.book.asks?.length ?? 0) > 0 ? (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-zinc-500 text-[10px] mb-1">BIDS (YES)</div>
                      {(selView.book.bids ?? []).map(([p, q], i) => (
                        <div key={`b${i}`} className="flex items-center gap-1 text-[10px] leading-4">
                          <span className="text-emerald-400 w-14">{(p * 100).toFixed(1)}</span>
                          <div className="flex-1 h-1.5 bg-zinc-800 rounded-sm overflow-hidden">
                            <div
                              className="h-full bg-emerald-600/70"
                              style={{
                                width: `${Math.min(100, (q / Math.max(...(selView.book.bids ?? []).map((l) => l[1]))) * 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-zinc-500 w-14 text-right">{q.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] mb-1">ASKS (YES)</div>
                      {(selView.book.asks ?? []).map(([p, q], i) => (
                        <div key={`a${i}`} className="flex items-center gap-1 text-[10px] leading-4">
                          <span className="text-red-400 w-14">{(p * 100).toFixed(1)}</span>
                          <div className="flex-1 h-1.5 bg-zinc-800 rounded-sm overflow-hidden">
                            <div
                              className="h-full bg-red-600/70"
                              style={{
                                width: `${Math.min(100, (q / Math.max(...(selView.book.asks ?? []).map((l) => l[1]))) * 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-zinc-500 w-14 text-right">{q.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-zinc-600 text-[10px]">No quotes in the book yet (testnet liquidity is thin)</div>
                )}
              </div>

              <div>
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
                  Thesis
                </div>
                <p className="text-zinc-300">{report.thesis}</p>
              </div>

              <div>
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
                  Key signals
                </div>
                <ul className="space-y-1">
                  {report.key_signals.map((s, i) => (
                    <li key={i} className="flex gap-2 text-zinc-300">
                      <span className="text-sky-500 shrink-0">▸</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
                  Risks
                </div>
                <ul className="space-y-1">
                  {report.risks.map((s, i) => (
                    <li key={i} className="flex gap-2 text-amber-200/80">
                      <span className="text-amber-500 shrink-0">⚠</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-zinc-800 pt-3">
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">
                  Suggested position (paper — no on-chain orders)
                </div>
                <div className="flex items-center gap-3">
                  {actionBadge(report.position_advice.action)}
                  <span className="text-zinc-300">
                    Bankroll share {(report.position_advice.positionPct * 100).toFixed(1)}%
                  </span>
                  {report.position_advice.entryPrice > 0 && (
                    <span className="text-zinc-400">
                      Entry {report.position_advice.entryPrice.toFixed(3)}
                    </span>
                  )}
                </div>
                <p className="text-zinc-500 mt-1.5">
                  {report.position_advice.rationale}
                </p>
                {report.position_advice.action !== "SKIP" && selView && (
                  <button
                    onClick={() => acceptSuggestion(selView.symbol)}
                    disabled={opening}
                    className="mt-2 w-full rounded border border-emerald-700 bg-emerald-900/40 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-800/50 disabled:opacity-50"
                  >
                    {opening ? "Filling (paper)…" : "Accept · paper fill (logs to Paper account)"}
                  </button>
                )}
              </div>

              <div className="text-zinc-600 text-[10px]">
                Model: d = {selView.model.dSigma.toFixed(2)}σ · annualized vol{" "}
                {selView.model.volAnnualized.toFixed(2)} ({selView.model.volSource}) ·
                spot {fmtPrice(selView.spot)}
                {selView.openPrice != null && (
                  <> / open {fmtPrice(selView.openPrice)}</>
                )}
                {selView.ema != null && <> / EMA {fmtPrice(selView.ema)}</>}
                {selView.strike != null && <> / strike {fmtPrice(selView.strike)}</>}
                {" · "}testnet data, demo only — not investment advice
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
