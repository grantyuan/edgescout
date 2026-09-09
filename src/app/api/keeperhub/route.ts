// /api/keeperhub — EdgeScout's KeeperHub execution layer.
//
// GET  /api/keeperhub
//   Status (60s in-memory cache): configured?, chain, USDC token, cap,
//   dryRun, org wallet address and the last 5 ledger executions. Honest
//   degraded state without a key: 200 { configured: false, note }.
//
// POST /api/keeperhub { symbol, mode?: "simulate" | "execute" }
//   Execute (or simulate) the KeeperHub transfer that mirrors an OPEN paper
//   position for the symbol. Amount = the position's 1/4-Kelly stake, capped
//   by KEEPERHUB_MAX_STAKE_USD. The resulting execution is written back into
//   the paper ledger entry (entry.keeperhub), so the transaction link shows
//   up in the dashboard. Idempotency: the key is derived from the entry id,
//   so re-clicking never double-spends.
//
// Errors: 400 bad body / no open position / zero stake; 409 not configured;
// 502 KeeperHub unreachable or transfer failed (execution details returned).
import { buildViewForSymbol } from "@/lib/market";
import { attachKeeperhubExecution, loadLedger } from "@/lib/paper";
import { collectExecutions, getConfig, getStatus, isConfigured, transferUsdc } from "@/lib/keeperhub";

const STATUS_CACHE_TTL_MS = 60_000;
let statusCache: { at: number; value: unknown } | null = null;

export async function GET() {
  const now = Date.now();
  if (statusCache && now - statusCache.at < STATUS_CACHE_TTL_MS) {
    return Response.json(statusCache.value);
  }
  const file = await loadLedger();
  const executions = collectExecutions(file.entries);
  const value = await getStatus({ executions });
  statusCache = { at: now, value };
  return Response.json(value);
}

export async function POST(request: Request) {
  let body: { symbol?: string; mode?: string; to?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { ok: false, error: 'invalid JSON body, expected { symbol, mode? }' },
      { status: 400 },
    );
  }
  const symbol = body.symbol?.trim() ?? "";
  if (!symbol) {
    return Response.json({ ok: false, error: "missing symbol" }, { status: 400 });
  }
  const mode = body.mode === "simulate" ? "simulate" : "execute";

  const cfg = getConfig();
  if (!isConfigured(cfg)) {
    return Response.json(
      { ok: false, error: "KeeperHub not configured: set KEEPERHUB_API_KEY in .env (org key, kh_...)" },
      { status: 409 },
    );
  }

  try {
    await buildViewForSymbol(symbol);
  } catch (e) {
    return Response.json(
      { ok: false, error: `market not found: ${(e as Error).message}` },
      { status: 404 },
    );
  }

  const file = await loadLedger();
  const entry = [...file.entries].reverse().find((e) => e.symbol === symbol && e.status === "open");
  if (!entry) {
    return Response.json(
      { ok: false, error: `no open paper position for ${symbol}; open one first (POST /api/paper/open)` },
      { status: 400 },
    );
  }

  // Double-spend guard: an entry that already carries a recorded execution
  // with a tx hash is never transferred again. The per-entry idempotency key
  // is defense in depth on the KeeperHub side; this is the primary guard.
  if (mode === "execute" && entry.keeperhub?.txHash) {
    return Response.json(
      { ok: false, error: "already executed for this position", execution: entry.keeperhub },
      { status: 409 },
    );
  }

  const amountUsd = Math.round(Math.min(entry.stake, cfg.maxStakeUsd) * 100) / 100;
  if (!(amountUsd > 0)) {
    return Response.json(
      { ok: false, error: "position stake rounds to zero; nothing to execute" },
      { status: 400 },
    );
  }

  const status = await getStatus({});
  const to = body.to?.trim() || status.wallet;
  if (to && !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    return Response.json(
      {
        ok: false,
        error: `invalid destination address "${to}" (expected 0x + 40 hex chars); pass a valid { to } explicitly`,
      },
      { status: 502 },
    );
  }
  if (!to) {
    return Response.json(
      {
        ok: false,
        error:
          "could not resolve the org wallet address (KeeperHub /api/user unreachable or empty); pass { to } explicitly",
      },
      { status: 502 },
    );
  }

  const execution = await transferUsdc({
    amountUsd,
    to,
    idempotencyKey: `edgescout-${entry.id}-${mode}`,
    simulate: mode === "simulate",
    cfg,
  });

  if (execution.status === "failed") {
    return Response.json(
      { ok: false, execution, error: execution.error ?? "KeeperHub transfer failed" },
      { status: 502 },
    );
  }

  const updated = await attachKeeperhubExecution(entry.id, execution);
  if (!updated) {
    // The transfer happened on-chain but could not be recorded (the position
    // settled in the meantime). Report it honestly instead of pretending the
    // ledger state is intact — otherwise a later trigger could re-execute it.
    return Response.json(
      {
        ok: false,
        error: "transfer succeeded but ledger write-back failed (position may have settled mid-flight); record the tx manually",
        execution,
      },
      { status: 502 },
    );
  }
  return Response.json({ ok: true, symbol, mode, execution, entry: updated });
}
