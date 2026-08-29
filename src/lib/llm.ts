// ---------------------------------------------------------------------------
// EdgeScout — LLM layer (OpenAI-compatible chat endpoint + mock fallback)
//
// Numbers never come from the LLM: the prompt receives pre-computed model
// outputs and the schema requires the model to *reference* them, not invent
// them. When no LLM_API_KEY is configured (or the call fails), a
// deterministic template report is returned instead, so the demo never
// breaks on stage.
// ---------------------------------------------------------------------------

import { LLM } from "./config.ts";
import type { MarketView } from "./market.ts";

export interface AgentReport {
  /** One-line punchline shown at the top of the report card. */
  headline: string;
  /** 2-4 sentence thesis: what the market prices, what the model sees. */
  thesis: string;
  /** 3-5 bullet signals the agent relied on. */
  key_signals: string[];
  /** 2-4 bullet risks/caveats. */
  risks: string[];
  /** Verdict label, e.g. "YES underpriced — modest edge". */
  verdict: string;
  /** 0-100 confidence in the verdict (model-consistent, not LLM-invented). */
  confidence: number;
  /** Suggested action + size, mirrors the deterministic sizing module. */
  position_advice: {
    action: "SKIP" | "BUY_YES" | "BUY_NO";
    positionPct: number;
    entryPrice: number;
    rationale: string;
  };
  /** Whether this report was produced by a real LLM or the mock fallback. */
  source: "llm" | "mock";
}

const SYSTEM_PROMPT = `You are EdgeScout, a quant analyst agent for binary event-contract markets on DreamDEX (Somnia). You receive pre-computed market data and a deterministic model output. Your job is to write a crisp analyst report that faithfully interprets those numbers.

Rules:
- NEVER invent prices, probabilities, or order book numbers. Use only the values given in the JSON input.
- Be concrete and numeric ("YES trades at 0.52, model fair value 0.61 → ~9pp underpriced").
- Write in the language of the "language" field in the input (here always "en"): the ENTIRE report — headline, thesis, key_signals, risks, verdict and position_advice.rationale — must be written in clear English. Never output Chinese or any other language.
- Reply with ONLY a JSON object matching the schema — no markdown fences.`;

const SCHEMA_HINT = `{
  "headline": string,        // <= 20 words, punchy
  "thesis": string,          // 2-4 sentences
  "key_signals": string[],   // 3-5 items
  "risks": string[],         // 2-4 items
  "verdict": string,         // short label
  "confidence": number,      // 0-100, consistent with the model's |dSigma| and edge size
  "position_advice": {
    "action": "SKIP" | "BUY_YES" | "BUY_NO",
    "positionPct": number,
    "entryPrice": number,
    "rationale": string      // 1-2 sentences
  }
}`;

function pct(x: number | null, digits = 1): string {
  return x == null ? "n/a" : `${(x * 100).toFixed(digits)}%`;
}

/** Human price formatting for report text (no raw float noise). */
function fmtPrice(x: number | null): string {
  return x == null ? "n/a" : x.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Compact numeric context passed to the model (all pre-computed). */
export function buildPromptPayload(view: MarketView): Record<string, unknown> {
  return {
    market: {
      symbol: view.symbol,
      asset: view.asset,
      kind: view.upDown ? "up/down vs window open price" : "strike",
      strike: view.strike,
      expires_at: view.expiresAt,
      seconds_to_expiry: view.secondsToExpiry,
      active: view.active,
    },
    orderbook: {
      yes_bid: view.book.yesBid,
      yes_ask: view.book.yesAsk,
      implied_yes_probability: view.pImplied,
      top5_depth_shares: view.book.depth,
      book_age_ms: view.book.timestamp != null ? Date.now() - view.book.timestamp : null,
    },
    underlying: {
      spot: view.spot,
      window_open_price: view.openPrice,
      ema_mark: view.ema,
      /** Settlement reference actually used by the model (strike / open / ema). */
      model_reference: view.upDown ? view.openPrice ?? view.ema : view.strike,
    },
    model: {
      p_yes: view.model.pModel,
      d_sigma: view.model.dSigma,
      vol_annualized: view.model.volAnnualized,
      vol_source: view.model.volSource,
    },
    analytics: {
      edge: view.edge,
      edge_kind: view.edgeKind,
      risk_score_0_100: view.risk,
      sizing: view.suggestion,
    },
    language: "en",
  };
}

/** Deterministic fallback report — same shape, real numbers, no LLM. */
export function mockReport(view: MarketView): AgentReport {
  const edge = view.edge;
  const s = view.suggestion;
  const d = view.model.dSigma;
  let verdict: string;
  let headline: string;
  if (edge == null || view.edgeKind === "n/a") {
    verdict = "Insufficient book data — no view yet";
    headline = `EdgeScout cannot evaluate ${view.symbol} — two-sided book missing`;
  } else if (view.edgeKind === "yes-underpriced") {
    verdict = "YES underpriced — positive model edge";
    headline = `EdgeScout: ${view.asset} book implies ${pct(view.pImplied)} vs model fair value ${pct(view.model.pModel)} — YES underpriced by ~${Math.abs(edge * 100).toFixed(1)}pp`;
  } else if (view.edgeKind === "yes-overpriced") {
    verdict = "YES overpriced — positive edge on NO";
    headline = `EdgeScout: ${view.asset} book implies ${pct(view.pImplied)} above model fair value ${pct(view.model.pModel)} — NO underpriced`;
  } else {
    verdict = "Book and model agree — watch";
    headline = `EdgeScout: ${view.symbol} book price is in line with model fair value (delta ${Math.abs(edge * 100).toFixed(1)}pp)`;
  }

  // Settlement reference exactly as the deterministic model uses it:
  // strike markets → strike; up/down markets → window open (EMA fallback).
  const ref = view.upDown ? view.openPrice ?? view.ema : view.strike;
  const refLabel = view.upDown
    ? view.openPrice != null
      ? "window open price"
      : "EMA reference (open price missing)"
    : "strike";

  const thesis =
    `${view.asset} is at ${fmtPrice(view.spot)}` +
    ` (${refLabel} ${fmtPrice(ref)})` +
    `, ${Math.max(view.secondsToExpiry, 0)}s to expiry. ` +
    `The model (zero-drift Brownian motion, annualized vol ${view.model.volAnnualized.toFixed(2)} [${view.model.volSource}]) puts YES at ${pct(view.model.pModel)},` +
    ` ~${Math.abs(d).toFixed(2)}σ from fair value. The book implies ${pct(view.pImplied)}.`;

  const spot = view.spot ?? 0;
  const above = ref != null ? spot >= ref : false;
  const deviationPct =
    ref != null && ref > 0 ? (Math.abs(Math.log(spot / ref)) * 100).toFixed(2) : "n/a";

  const key_signals = [
    `Spot ${fmtPrice(view.spot)} vs reference (${refLabel}) ${fmtPrice(ref)}: price is ${above ? "above" : "below"} the reference, deviation ${deviationPct}%`,
    `d = ${d.toFixed(2)}σ: ${Math.abs(d) < 0.5 ? "close to the strike — near coin-flip" : "clear deviation, strong directionality"}`,
    `Book depth (top5 both sides, ${view.book.depth} shares): ${view.book.depth > 500 ? "good liquidity" : "thin liquidity, watch slippage"}`,
    `Model edge: ${edge == null ? "n/a" : (edge * 100).toFixed(1) + "pp"}`,
  ];

  const risks = [
    `${Math.max(view.secondsToExpiry, 0)}s remaining: shorter windows make sudden volatility more decisive`,
    `Vol source: ${view.model.volSource === "candles" ? "measured from the last 60 1m candles" : "default (insufficient data)"} — may deviate from true volatility`,
    "Binary contracts settle all-or-nothing; concentrated single-direction risk",
    "testnet data for demo only — not investment advice",
  ];

  const action = s?.action ?? "SKIP";
  const positionPct = s?.positionPct ?? 0;
  const entryPrice = s?.entryPrice ?? 0;
  const rationale =
    positionPct > 0
      ? `1/4 Kelly position, capped at 20% of bankroll; entry ${entryPrice.toFixed(3)} — abandon if the book drifts >2pp before fill`
      : "Edge below threshold or book missing a side — stand down, no position";

  return {
    headline,
    thesis,
    key_signals,
    risks,
    verdict,
    confidence: confidenceFromModel(view),
    position_advice: { action, positionPct, entryPrice, rationale },
    source: "mock",
  };
}

/** Confidence derived from deterministic inputs (|d|, edge, liquidity). */
function confidenceFromModel(view: MarketView): number {
  const dScore = Math.min(40, Math.abs(view.model.dSigma) * 25); // |d|=1.6σ → 40
  const edgeScore = view.edge == null ? 0 : Math.min(30, Math.abs(view.edge) * 300);
  const liqScore = view.book.depth > 500 ? 15 : view.book.depth > 100 ? 8 : 2;
  const dataScore = view.spot != null && view.pImplied != null ? 15 : 0;
  return Math.min(95, Math.round(dScore + edgeScore + liqScore + dataScore));
}

async function callLLM(view: MarketView): Promise<AgentReport> {
  const payload = buildPromptPayload(view);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Self-hosted / keyless endpoints: only send Authorization when a key exists.
  if (LLM.apiKey) headers.Authorization = `Bearer ${LLM.apiKey}`;
  const res = await fetch(`${LLM.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: LLM.model,
      temperature: LLM.temperature,
      max_tokens: LLM.maxTokens,
      messages: [
        { role: "system", content: SYSTEM_PROMPT + "\n\nOutput schema:\n" + SCHEMA_HINT },
        { role: "user", content: JSON.stringify(payload) },
      ],
      // For Qwen3-style reasoning models served by SGLang, disable chain-of-thought
      // so the JSON answer is not truncated by reasoning tokens.
      ...(/qwen/i.test(LLM.model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...LLM.extraBody,
    }),
    signal: AbortSignal.timeout(LLM.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "";
  const jsonText = content.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  const parsed = JSON.parse(jsonText) as Partial<AgentReport>;
  const s = view.suggestion;
  return {
    headline: String(parsed.headline ?? mockReport(view).headline),
    thesis: String(parsed.thesis ?? mockReport(view).thesis),
    key_signals: Array.isArray(parsed.key_signals) ? parsed.key_signals.map(String) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    verdict: String(parsed.verdict ?? mockReport(view).verdict),
    // Confidence is always re-derived from deterministic inputs; the LLM's
    // number is ignored to keep reports comparable across providers.
    confidence: confidenceFromModel(view),
    position_advice: {
      action: s?.action ?? "SKIP",
      positionPct: s?.positionPct ?? 0,
      entryPrice: s?.entryPrice ?? 0,
      rationale:
        s && positionPctHasEdge(s)
          ? "1/4 Kelly position, capped at 20% of bankroll (deterministic computation, not LLM-generated)"
          : "Edge below threshold or book missing a side — stand down",
    },
    source: "llm",
  };
}

function positionPctHasEdge(s: { action: string; positionPct: number }): boolean {
  return s.action !== "SKIP" && s.positionPct > 0;
}

/** Entry point: LLM when configured, mock otherwise; never throws. */
export async function generateReport(view: MarketView): Promise<AgentReport> {
  if (!LLM.enabled) return mockReport(view);
  try {
    return await callLLM(view);
  } catch (err) {
    console.error("[edge-scout] LLM failed, falling back to mock:", (err as Error).message);
    return { ...mockReport(view), headline: mockReport(view).headline + " (LLM unavailable, template mode)" };
  }
}
