// EdgeScout - KeeperHub execution layer (testnet USDC on Base Sepolia).
//
// When EdgeScout's deterministic model sizes a paper position, KeeperHub
// (https://app.keeperhub.com) moves testnet USDC on Base Sepolia; the
// resulting transaction link is written back into the paper ledger entry
// (paper.ts attachKeeperhubExecution). This powers the DoraHacks
// "KeeperHub - The Agent Economy" entry.
//
// Transport: KeeperHub MCP JSON-RPC over streamable HTTP POST {base}/mcp
// with Authorization: Bearer kh_... . Every network call goes through an
// injectable transport so the unit tests run fully offline. Where a
// KeeperHub API detail could not be confirmed from the docs, the code is
// defensive and the assumption is marked "ASSUMED:".
//
// Honest degraded state: without KEEPERHUB_API_KEY nothing is configured -
// getStatus() answers { ok: true, configured: false, note } instead of
// failing (same pattern as /api/asc "not deployed yet").

export interface KeeperhubConfig {
  apiKey: string;
  apiBase: string;
  chain: string;
  usdc: string;
  maxStakeUsd: number;
  dryRun: boolean;
}

/** Read env lazily so tests can pass a cfg or override process.env. */
export function getConfig(): KeeperhubConfig {
  const base = (process.env.KEEPERHUB_API_BASE ?? "https://app.keeperhub.com")
    .trim();
  return {
    apiKey: (process.env.KEEPERHUB_API_KEY ?? "").trim(),
    apiBase: base.replace(/\/$/, ""),
    chain: (process.env.KEEPERHUB_CHAIN ?? "base-sepolia").trim(),
    usdc: (
      process.env.KEEPERHUB_USDC ??
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    ).trim(),
    maxStakeUsd: (() => {
      const n = Number(process.env.KEEPERHUB_MAX_STAKE_USD ?? 25);
      return Number.isFinite(n) && n > 0 ? n : 25;
    })(),
    dryRun: (process.env.KEEPERHUB_DRY_RUN ?? "").trim() === "true",
  };
}

/** Result of one KeeperHub execution attempt (JSON-safe, ledger-storable). */
export interface KeeperhubExecution {
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
}

/** Minimal response shape the transport must provide. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: () => Promise<unknown>;
  /** Optional raw body reader, used to recover JSON-RPC from SSE/non-JSON bodies. */
  text?: () => Promise<string>;
}

/** fetch-like transport; inject a fake in unit tests. */
export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

// --- MCP transport internals ------------------------------------------------

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
}

function authHeaders(cfg: KeeperhubConfig, session?: string): Record<string, string> {
  const h: Record<string, string> = { ...jsonHeaders(), Authorization: `Bearer ${cfg.apiKey}` };
  if (session) h["Mcp-Session-Id"] = session;
  return h;
}

/** Case-insensitive header lookup (MCP servers vary on exact casing). */
function headerOf(res: HttpResponse, name: string): string | null {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (k.toLowerCase() === key) return String(v);
  }
  return null;
}

/**
 * MCP initialize handshake. ASSUMED: the streamable-HTTP MCP endpoint lives at
 * {apiBase}/mcp and may return the session id via the Mcp-Session-Id response
 * header; when it does not, calls proceed without a session header.
 */
async function mcpInitialize(
  cfg: KeeperhubConfig, transport: Transport,
): Promise<{ sessionId: string | null } | never> {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "edgescout", version: "1.0.0" },
    },
  });
  const res = await transport(`${cfg.apiBase}/mcp`, { method: "POST", headers: authHeaders(cfg), body });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`KeeperHub MCP rejected the API key (HTTP ${res.status})`);
  }
  if (res.status >= 400) {
    throw new Error(`KeeperHub MCP initialize failed (HTTP ${res.status})`);
  }
  return { sessionId: headerOf(res, "mcp-session-id") };
}

/** Fire the initialized notification; tolerated to fail (no response body). */
async function mcpNotifyInitialized(
  cfg: KeeperhubConfig, transport: Transport, sessionId: string | null,
): Promise<void> {
  const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  await transport(`${cfg.apiBase}/mcp`, { method: "POST", headers: authHeaders(cfg, sessionId ?? undefined), body })
    .catch(() => { /* notifications have no response; some servers close the stream */ });
}

async function mcpCall(
  cfg: KeeperhubConfig, transport: Transport, sessionId: string | null,
  tool: string, args: Record<string, unknown>,
): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  const headers = authHeaders(cfg, sessionId ?? undefined);
  // KeeperHub's Safe First-Write Sequence also carries the dedupe key as an
  // Idempotency-Key header; the argument spelling covers the MCP side, the
  // header covers the REST-shaped side. Same value in both.
  const idemKey = args.idempotencyKey ?? args.idempotency_key;
  if (typeof idemKey === "string" && idemKey) headers["Idempotency-Key"] = idemKey;
  const res = await transport(`${cfg.apiBase}/mcp`, { method: "POST", headers, body });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`KeeperHub MCP rejected the API key (HTTP ${res.status})`);
  }
  if (res.status >= 400) {
    throw new Error(`KeeperHub MCP ${tool} failed (HTTP ${res.status})`);
  }
  // Read the body exactly once, based on content type. MCP streamable-HTTP
  // may answer with an SSE stream; recover the JSON-RPC message from text.
  // An unreadable response must never surface as "submitted" — fail loudly.
  const ct = headerOf(res, "content-type") ?? "";
  let payload: unknown = null;
  if (ct.includes("application/json") || ct === "") {
    payload = await res.json().catch(() => null);
    if (payload == null && res.text) {
      payload = extractJsonRpcPayload(await res.text().catch(() => ""));
    }
  } else if (res.text) {
    payload = extractJsonRpcPayload(await res.text().catch(() => ""));
  }
  if (payload == null) {
    throw new Error(
      `KeeperHub MCP ${tool}: unparseable response (HTTP ${res.status}, content-type: ${ct || "none"})`,
    );
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    const err = (payload as { error?: { message?: string } }).error;
    throw new Error(`KeeperHub MCP ${tool} error: ${err?.message ?? "unknown"}`);
  }
  return payload && typeof payload === "object" && "result" in payload
    ? (payload as { result: unknown }).result
    : payload;
}

/** Extract a JSON-RPC object from an SSE / plain-text body (last data: line first). */
function extractJsonRpcPayload(raw: string): unknown {
  if (!raw || !raw.trim()) return null;
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("data:")) {
      const candidate = line.slice(5).trim();
      if (candidate && candidate !== "[DONE]") {
        try { return JSON.parse(candidate); } catch { /* keep scanning */ }
      }
    }
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

function findKey(obj: unknown, keys: string[], depth = 0): unknown {
  if (depth > 6 || obj == null || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (rec[k] !== undefined && rec[k] !== null && rec[k] !== "") return rec[k];
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") {
      const hit = findKey(v, keys, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * Normalize an MCP tool result into the fields we need. Handles both
 * structuredContent objects and text content parts (JSON-parsed when
 * possible). Defensive: unknown shapes yield nulls, not throws.
 */
export function parseToolResult(result: unknown): {
  txHash: string | null; txLink: string | null; status: string | null;
  success: boolean | null; wouldRevert: boolean | null; executionId: string | null;
} {
  let source: unknown = result;
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown[] }).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "text" in part) {
          const text = String((part as { text: unknown }).text);
          try { source = JSON.parse(text); } catch { source = text; }
          break;
        }
      }
    }
  }
  const hash = findKey(source, ["transactionHash", "transaction_hash", "txHash", "hash"]);
  const link = findKey(source, ["transactionLink", "transaction_link", "explorer", "link"]);
  const status = findKey(source, ["status", "state"]);
  const success = findKey(source, ["success"]);
  const wouldRevert = findKey(source, ["wouldRevert", "would_revert"]);
  const executionId = findKey(source, ["executionId", "execution_id", "executionID"]);
  return {
    txHash: hash ? String(hash) : null,
    txLink: link ? String(link) : null,
    status: status ? String(status) : null,
    success: success === undefined || success === null ? null : Boolean(success),
    wouldRevert: wouldRevert === undefined || wouldRevert === null ? null : Boolean(wouldRevert),
    executionId: executionId ? String(executionId) : null,
  };
}

export function isConfigured(cfg: KeeperhubConfig = getConfig()): boolean {
  return cfg.apiKey.length > 0;
}

/**
 * Size the on-chain transfer for a market suggestion.
 * stake = suggestion.positionPct * paperBalance, capped by maxStakeUsd,
 * rounded to 2 decimals. Returns 0 (with a reason) when nothing should run.
 */
/**
 * Map a chain name (KEEPERHUB_CHAIN) to the numeric chain id string used by
 * KeeperHub's documented request shapes. Unknown/numeric values pass through.
 */
export function chainIdOf(chain: string): string {
  const c = chain.trim().toLowerCase();
  if (c === "base-sepolia" || c === "base_sepolia") return "84532";
  if (c === "base") return "8453";
  if (c === "sepolia" || c === "ethereum-sepolia" || c === "ethereum_sepolia") return "11155111";
  return chain.trim();
}

export function sizeTransfer(
  suggestion: { positionPct: number } | null | undefined,
  paperBalanceUsd: number,
  cfg: KeeperhubConfig = getConfig(),
): { amountUsd: number; reason: string } {
  if (!suggestion || suggestion.positionPct <= 0) return { amountUsd: 0, reason: "no executable suggestion" };
  let amount = suggestion.positionPct * paperBalanceUsd;
  if (amount > cfg.maxStakeUsd) amount = cfg.maxStakeUsd;
  amount = Math.round(amount * 100) / 100;
  if (amount <= 0) return { amountUsd: 0, reason: "stake rounds to zero" };
  return { amountUsd: amount, reason: "ok" };
}

export interface TransferRequest {
  amountUsd: number;
  to: string;
  /** Idempotency key - same key never double-spends. */
  idempotencyKey: string;
  simulate?: boolean;
  cfg?: KeeperhubConfig;
  transport?: Transport;
  now?: () => number;
}

/**
 * REST Direct Execution fallback (docs.keeperhub.com/api/direct-execution):
 * POST {base}/api/execute/transfer with the documented field names. Used when
 * the MCP surface fails; the SAME idempotency key makes a fallback after a
 * partially-completed MCP call dedupe on the server (no double-spend).
 * Returns the parsed response body (plain object).
 */
async function restTransfer(
  cfg: KeeperhubConfig, transport: Transport,
  body: Record<string, unknown>, idempotencyKey: string,
): Promise<unknown> {
  const res = await transport(`${cfg.apiBase}/api/execute/transfer`, {
    method: "POST",
    headers: {
      ...jsonHeaders(),
      Authorization: `Bearer ${cfg.apiKey}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  if (res.status >= 400) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: unknown; message?: unknown };
      detail = String(j?.error ?? j?.message ?? JSON.stringify(j)).slice(0, 200);
    } catch { /* no body */ }
    throw new Error(`KeeperHub REST transfer failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const payload = await res.json().catch(() => null);
  if (payload == null) {
    throw new Error(`KeeperHub REST transfer: unparseable response (HTTP ${res.status})`);
  }
  return payload;
}

/**
 * Execute (or simulate) one testnet USDC transfer via KeeperHub MCP.
 * Always returns a KeeperhubExecution; never throws for expected failures.
 */
export async function transferUsdc(req: TransferRequest): Promise<KeeperhubExecution> {
  const cfg = req.cfg ?? getConfig();
  const transport: Transport = req.transport ?? (async (url, init) => {
    const r = await fetch(url, init);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { status: r.status, headers, json: () => r.json(), text: () => r.text() };
  });
  const exec: KeeperhubExecution = {
    executionId: `kh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    chain: cfg.chain, amountUsd: req.amountUsd, from: "", to: req.to,
    txHash: null, txLink: null, status: "failed", executedAt: (req.now ?? Date.now)(),
  };
  if (!isConfigured(cfg)) {
    exec.error = "KeeperHub not configured: set KEEPERHUB_API_KEY in .env";
    return exec;
  }
  if (!(req.amountUsd > 0)) {
    exec.error = "amountUsd must be positive";
    return exec;
  }
  try {
    const simulate = req.simulate === true || cfg.dryRun;
    // Documented MCP argument names (docs.keeperhub.com "Safe First-Write
    // Sequence"): chain_id as a numeric string, to_address, human-readable
    // amount, idempotency_key.
    const args = {
      chain_id: chainIdOf(cfg.chain),
      to_address: req.to,
      token_address: cfg.usdc,
      amount: req.amountUsd.toFixed(2),
      idempotency_key: req.idempotencyKey,
      simulate,
    };
    // REST fallback body (documented field names).
    const restBody: Record<string, unknown> = {
      chainId: Number(chainIdOf(cfg.chain)),
      recipientAddress: req.to,
      tokenAddress: cfg.usdc,
      amount: req.amountUsd.toFixed(2),
    };
    if (simulate) restBody.simulate = true;

    const mcpAttempt = async (): Promise<unknown> => {
      const { sessionId } = await mcpInitialize(cfg, transport);
      await mcpNotifyInitialized(cfg, transport, sessionId);
      return await mcpCall(cfg, transport, sessionId, "execute_transfer", args);
    };
    let result: unknown;
    let mcpError: Error | null = null;
    let mcpOk = false;
    try {
      result = await mcpAttempt();
      mcpOk = true;
    } catch (first) {
      mcpError = first instanceof Error ? first : new Error(String(first));
      // Documented client behavior: on 401/404 the session or key may have
      // been reset - retry once with a fresh handshake before giving up on
      // the MCP surface.
      if (/HTTP 40[14]/.test(mcpError.message)) {
        try {
          result = await mcpAttempt();
          mcpOk = true;
        } catch (second) {
          mcpError = second instanceof Error ? second : new Error(String(second));
        }
      }
    }
    if (!mcpOk) {
      // REST fallback on any MCP failure. Same idempotency key: if the MCP
      // call already executed, the REST request dedupes server-side instead
      // of double-spending. If the fallback fails too, surface BOTH errors.
      try {
        result = await restTransfer(cfg, transport, restBody, req.idempotencyKey);
      } catch (restErr) {
        const restMsg = restErr instanceof Error ? restErr.message : String(restErr);
        throw new Error(`MCP: ${mcpError?.message ?? "unavailable"}; REST fallback failed: ${restMsg}`);
      }
    }
    const parsed = parseToolResult(result);
    if (simulate) {
      // Docs: continue only when the simulation reports success && !wouldRevert.
      // A failed preflight must surface as failed, never as "simulated".
      if (parsed.success === false || parsed.wouldRevert === true) {
        exec.status = "failed";
        exec.error = "simulation preflight did not pass (success=false or wouldRevert=true)";
      } else {
        exec.status = "simulated";
      }
    } else {
      // Terminal failure without a hash (spend-cap breach, guard rejection)
      // must not be misreported as "submitted".
      if (parsed.status === "failed" && !parsed.txHash) {
        exec.status = "failed";
        exec.error = "execution reported failed by KeeperHub (no transaction)";
      } else if (
        !parsed.txHash && !parsed.txLink && !parsed.executionId && !parsed.status
      ) {
        // A 2xx with an empty/blank payload carries no execution evidence -
        // never misreport it as "submitted". Keep the root MCP error visible
        // when the REST fallback is what produced the empty payload.
        exec.status = "failed";
        exec.error = `no execution evidence in KeeperHub response (empty payload)` +
          (mcpError ? `; MCP attempt failed: ${mcpError.message}` : "");
      } else {
        exec.executionId = parsed.executionId ?? exec.executionId;
        exec.txHash = parsed.txHash;
        exec.txLink = parsed.txLink;
        exec.status = parsed.txHash || parsed.txLink ? "success" : "submitted";
      }
    }
    return exec;
  } catch (e) {
    exec.status = "failed";
    exec.error = e instanceof Error ? e.message : String(e);
    return exec;
  }
}

export interface KeeperhubStatus {
  ok: boolean;
  configured: boolean;
  chain: string;
  usdc: string;
  maxStakeUsd: number;
  dryRun: boolean;
  wallet: string | null;
  lastExecutions: KeeperhubExecution[];
  note?: string;
}

/**
 * Dashboard status. Honest degraded state: no API key -> configured:false +
 * a note, ok:true. With a key, tries GET {apiBase}/api/user for the org
 * wallet address (ASSUMED endpoint shape; on any failure the wallet stays
 * null and a note explains, but the panel still works).
 */
export async function getStatus(
  opts: { cfg?: KeeperhubConfig; transport?: Transport; executions?: KeeperhubExecution[] } = {},
): Promise<KeeperhubStatus> {
  const cfg = opts.cfg ?? getConfig();
  const executions = (opts.executions ?? []).slice(-5).reverse();
  if (!isConfigured(cfg)) {
    return {
      ok: true, configured: false, chain: cfg.chain, usdc: cfg.usdc,
      maxStakeUsd: cfg.maxStakeUsd, dryRun: cfg.dryRun, wallet: null,
      lastExecutions: executions,
      note: "Set KEEPERHUB_API_KEY in .env (org key, starts with kh_) to enable on-chain execution.",
    };
  }
  const transport: Transport = opts.transport ?? (async (url, init) => {
    const r = await fetch(url, init);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { status: r.status, headers, json: () => r.json(), text: () => r.text() };
  });
  let wallet: string | null = null;
  let note: string | undefined;
  try {
    const res = await transport(`${cfg.apiBase}/api/user`, { method: "GET", headers: authHeaders(cfg) });
    if (res.status >= 400) {
      note = `KeeperHub /api/user returned HTTP ${res.status}; wallet display unavailable, execution still works.`;
    } else {
      const payload = await res.json().catch(() => null);
      wallet = (findKey(payload, ["wallet", "address", "walletAddress", "orgWallet"])) as string | null ?? null;
    }
  } catch (e) {
    note = `Could not reach KeeperHub /api/user (${e instanceof Error ? e.message : String(e)}); execution still works.`;
  }
  return {
    ok: true, configured: true, chain: cfg.chain, usdc: cfg.usdc,
    maxStakeUsd: cfg.maxStakeUsd, dryRun: cfg.dryRun, wallet,
    lastExecutions: executions, note,
  };
}

/** Collect KeeperHub executions stored on paper ledger entries (newest last). */
export function collectExecutions(entries: Array<{ keeperhub?: KeeperhubExecution | null }>): KeeperhubExecution[] {
  const out: KeeperhubExecution[] = [];
  for (const e of entries) {
    if (e && e.keeperhub && typeof e.keeperhub === "object" && e.keeperhub.executionId) out.push(e.keeperhub);
  }
  return out;
}
