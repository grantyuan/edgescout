// ---------------------------------------------------------------------------
// EdgeScout — configuration
// All keys come from process.env (see .env.example). Nothing here is a secret
// for the testnet demo; the LLM key (if provided) must never be inlined.
// ---------------------------------------------------------------------------

export const SOMNIA_TESTNET = {
  chainId: 50312,
  chainName: "somnia-testnet",
  rpcHttp: "https://api.infra.testnet.somnia.network",
  rpcWs: "wss://api.infra.testnet.somnia.network/ws",
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
} as const;

/**
 * Testnet venue id for DreamDEX event contracts. The venue id HAS moved in the
 * past (three times in the first week of August), so this value is a fallback
 * only: `board.ts` re-derives the venue from live market rows when the filter
 * comes back empty.
 */
export const TESTNET_VENUE_ID =
  process.env.VENUE_ID?.trim() ||
  "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";

/** How many markets the board renders (books are fetched per market). */
export const BOARD_SIZE = Number(process.env.BOARD_SIZE || 24);

/** Board cache TTL — the indexer lags the chain by seconds; 10s is enough. */
export const BOARD_CACHE_TTL_MS = 10_000;

// --- LLM -------------------------------------------------------------------
// Any OpenAI-compatible chat endpoint works (OpenAI, DeepSeek, local sglang…).
// When no LLM is configured (no key AND no non-default endpoint) the agent
// falls back to a deterministic template report (mock mode) so the demo never
// breaks on stage. Self-hosted endpoints may be keyless: an explicitly
// non-default LLM_BASE_URL enables live mode even with an empty key.
const LLM_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const llmKey = (process.env.LLM_API_KEY ?? "").trim();
const llmBaseUrl = (process.env.LLM_BASE_URL ?? "").trim();
// Optional raw-JSON fragment merged into the chat/completions request body
// (e.g. '{"chat_template_kwargs":{"enable_thinking":false}}' for Qwen3 sglang).
let llmExtraBody: Record<string, unknown> = {};
const extraBodyRaw = (process.env.LLM_EXTRA_BODY ?? "").trim();
if (extraBodyRaw) {
  try {
    const parsed = JSON.parse(extraBodyRaw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      llmExtraBody = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed LLM_EXTRA_BODY is ignored; the request is sent without it.
  }
}

export const LLM = {
  enabled:
    llmKey.length > 0 ||
    (llmBaseUrl.length > 0 && llmBaseUrl !== LLM_DEFAULT_BASE_URL),
  baseUrl: (llmBaseUrl || LLM_DEFAULT_BASE_URL).replace(/\/$/, ""),
  apiKey: llmKey,
  model: process.env.LLM_MODEL || "gpt-4o-mini",
  temperature: 0.3,
  // Reasoning models spend output budget on chain-of-thought before the
  // answer — 1500 leaves headroom for schema JSON on top of thinking.
  maxTokens: Number(process.env.LLM_MAX_TOKENS || 1500),
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60_000),
  extraBody: llmExtraBody,
};

// --- Paper trading -----------------------------------------------------------
export const PAPER = {
  startingBalance: 10_000, // tUSDC (demo only, never real funds)
  /** Fraction of full Kelly. Full Kelly is too aggressive for a demo. */
  kellyFraction: 0.25,
  maxPositionPct: 0.2,
};

/** Default annualized vols when candle history is unavailable. */
export const DEFAULT_VOL = { BTC: 0.4, ETH: 0.55 } as Record<string, number>;
