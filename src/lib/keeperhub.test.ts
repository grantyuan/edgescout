// EdgeScout - KeeperHub execution layer tests (node:test, fully offline).
// A fake transport records requests and returns canned responses (no I/O).
// paper.ts is imported after chdir into a temp dir (never touches the real
// demo ledger).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "edgescout-keeperhub-test-"));
process.chdir(tmpRoot);

for (const k of ["KEEPERHUB_API_KEY", "KEEPERHUB_API_BASE", "KEEPERHUB_CHAIN", "KEEPERHUB_USDC", "KEEPERHUB_MAX_STAKE_USD", "KEEPERHUB_DRY_RUN"]) {
  delete process.env[k];
}

const kh = await import("./keeperhub.ts");
const paper = await import("./paper.ts");

const CFG = {
  apiKey: "kh_test_key_123",
  apiBase: "https://app.keeperhub.com",
  chain: "base-sepolia",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  maxStakeUsd: 25,
  dryRun: false,
};

type FakeResponse = { status: number; headers?: Record<string, string>; payload?: unknown; text?: string; failJson?: boolean };
type FakeResponder = (url: string, body: string) => FakeResponse;

class FakeTransport {
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  private responses: FakeResponder[] = [];
  respond(r: FakeResponder) { this.responses.push(r); return this; }
  async run(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
    this.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const out = this.responses.length ? this.responses.shift()!(url, init.body ?? "") : { status: 200, payload: {} };
    return {
      status: out.status,
      headers: out.headers ?? {},
      json: async () => {
        if (out.failJson) throw new Error("not json");
        return out.payload ?? {};
      },
      text: async () => out.text ?? "",
    };
  }
}

function mcpOk(payload: unknown, extraHeaders: Record<string, string> = {}) {
  return { status: 200, headers: { "Mcp-Session-Id": "sess-1", ...extraHeaders }, payload };
}

const TX_RESULT = { result: { content: [{ type: "text", text: JSON.stringify({ transactionHash: "0xabc", transactionLink: "https://sepolia.basescan.org/tx/0xabc", status: "success" }) }] } };

function transferTransport(tx: unknown = TX_RESULT) {
  const t = new FakeTransport();
  t.respond(() => mcpOk({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
  t.respond(() => ({ status: 202, payload: {} }));
  t.respond(() => mcpOk(tx));
  return t;
}

test("getConfig: defaults when env is unset", () => {
  const cfg = kh.getConfig();
  assert.equal(cfg.apiKey, "");
  assert.equal(cfg.apiBase, "https://app.keeperhub.com");
  assert.equal(cfg.chain, "base-sepolia");
  assert.equal(cfg.maxStakeUsd, 25);
  assert.equal(cfg.dryRun, false);
});

test("isConfigured: empty key false, org key true", () => {
  assert.equal(kh.isConfigured({ ...CFG, apiKey: "" }), false);
  assert.equal(kh.isConfigured(CFG), true);
});

test("sizeTransfer: pct*balance, capped, and zero cases", () => {
  assert.deepEqual(kh.sizeTransfer({ positionPct: 0.2 }, 100, CFG), { amountUsd: 20, reason: "ok" });
  assert.deepEqual(kh.sizeTransfer({ positionPct: 0.8 }, 100, CFG), { amountUsd: 25, reason: "ok" });
  assert.deepEqual(kh.sizeTransfer(null, 100, CFG), { amountUsd: 0, reason: "no executable suggestion" });
  assert.deepEqual(kh.sizeTransfer({ positionPct: 0.0001 }, 1, CFG), { amountUsd: 0, reason: "stake rounds to zero" });
});

test("parseToolResult: structured, text-content, and unknown shapes", () => {
  assert.equal(kh.parseToolResult({ transactionHash: "0x1", transactionLink: "https://x/tx/0x1", status: "success" }).txHash, "0x1");
  const wrapped = kh.parseToolResult({ content: [{ type: "text", text: JSON.stringify({ txHash: "0x2", link: "https://x/tx/0x2" }) }] });
  assert.equal(wrapped.txHash, "0x2");
  assert.equal(wrapped.txLink, "https://x/tx/0x2");
  assert.deepEqual(kh.parseToolResult({ foo: "bar" }), { txHash: null, txLink: null, status: null, success: null, wouldRevert: null, executionId: null });
  assert.equal(kh.parseToolResult({ success: true, wouldRevert: false }).success, true);
  assert.equal(kh.parseToolResult({ success: false }).success, false);
  assert.equal(kh.parseToolResult({ wouldRevert: true }).wouldRevert, true);
});

test("transferUsdc: unconfigured -> failed with note, zero network calls", async () => {
  const t = new FakeTransport();
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", cfg: { ...CFG, apiKey: "" }, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "failed");
  assert.match(ex.error ?? "", /not configured/);
  assert.equal(t.calls.length, 0);
});

test("transferUsdc: simulate preflight, no tx", async () => {
  const t = transferTransport({ result: { content: [{ type: "text", text: JSON.stringify({ simulation: "ok" }) }] } });
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", simulate: true, cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "simulated");
  assert.equal(ex.txHash, null);
  assert.equal(t.calls.length, 3);
  const call = JSON.parse(t.calls[2].body!);
  assert.equal(call.params.name, "execute_transfer");
  assert.equal(call.params.arguments.simulate, true);
  assert.equal(call.params.arguments.idempotency_key, "k1");
  assert.equal(call.params.arguments.chain_id, "84532");
  assert.equal(call.params.arguments.to_address, "0xdst");
  assert.equal(call.params.arguments.token_address, CFG.usdc);
  assert.equal(call.params.arguments.amount, "5.00");
  assert.equal(t.calls[2].headers.Authorization, "Bearer kh_test_key_123");
  assert.equal(t.calls[2].headers["Mcp-Session-Id"], "sess-1");
  assert.equal(t.calls[2].headers["Idempotency-Key"], "k1"); // dedupe key also sent as header
});

test("transferUsdc: simulate wouldRevert=true -> failed, not 'simulated'", async () => {
  const t = transferTransport({ result: { content: [{ type: "text", text: JSON.stringify({ success: true, wouldRevert: true, code: "insufficient_balance" }) }] } });
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", simulate: true, cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "failed");
  assert.match(ex.error ?? "", /preflight/);
});

test("transferUsdc: simulate success=false -> failed", async () => {
  const t = transferTransport({ result: { content: [{ type: "text", text: JSON.stringify({ success: false, wouldRevert: false, message: "chain disabled" }) }] } });
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", simulate: true, cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "failed");
  assert.match(ex.error ?? "", /preflight/);
});

test("transferUsdc: live transfer returns tx link and success", async () => {
  const t = transferTransport();
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "success");
  assert.equal(ex.txHash, "0xabc");
  assert.equal(ex.txLink, "https://sepolia.basescan.org/tx/0xabc");
  const call = JSON.parse(t.calls[2].body!);
  assert.equal(call.params.arguments.simulate, false);
  assert.equal(call.params.arguments.chain_id, "84532");
});

test("transferUsdc: 404 on tools/call retried once with a fresh session", async () => {
  const t = new FakeTransport();
  t.respond(() => mcpOk({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
  t.respond(() => ({ status: 202, payload: {} }));
  t.respond(() => ({ status: 404, payload: {} }));
  t.respond(() => mcpOk({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
  t.respond(() => ({ status: 202, payload: {} }));
  t.respond(() => mcpOk(TX_RESULT));
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k-retry", cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "success");
  assert.equal(ex.txHash, "0xabc");
  assert.equal(t.calls.length, 6);
});

test("transferUsdc: 401 on initialize -> retry, then REST fallback also rejected", async () => {
  const t = new FakeTransport();
  t.respond(() => ({ status: 401, payload: {} }));
  t.respond(() => ({ status: 401, payload: {} })); // the one MCP retry is rejected too
  t.respond(() => ({ status: 401, payload: { error: "invalid API key" } })); // REST fallback rejected
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "failed");
  assert.match(ex.error ?? "", /REST transfer failed \(HTTP 401\)/);
});

test("transferUsdc: MCP 500 falls back to REST /api/execute/transfer", async () => {
  const t = new FakeTransport();
  t.respond(() => mcpOk({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
  t.respond(() => ({ status: 202, payload: {} }));
  t.respond(() => ({ status: 500, payload: {} })); // tools/call explodes
  t.respond(() => ({
    status: 202,
    payload: {
      executionId: "direct_1", status: "completed",
      transactionHash: "0xrest", transactionLink: "https://sepolia.basescan.org/tx/0xrest",
    },
  }));
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "success");
  assert.equal(ex.txHash, "0xrest");
  const rest = t.calls[3];
  assert.match(rest.url, /\/api\/execute\/transfer$/);
  assert.equal(rest.headers["Idempotency-Key"], "k1");
  const body = JSON.parse(rest.body!);
  assert.equal(body.chainId, 84532);
  assert.equal(body.recipientAddress, "0xdst");
  assert.equal(body.tokenAddress, CFG.usdc);
  assert.equal(body.amount, "5.00");
  assert.equal(body.simulate, undefined); // execute, not simulate
});

test("transferUsdc: REST terminal status 'failed' without hash -> failed, not 'submitted'", async () => {
  const t = new FakeTransport();
  t.respond(() => mcpOk({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
  t.respond(() => ({ status: 202, payload: {} }));
  t.respond(() => ({ status: 503, payload: {} })); // MCP down
  t.respond(() => ({ status: 202, payload: { executionId: "direct_2", status: "failed", error: "Daily spending cap exceeded" } }));
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "failed");
  assert.equal(ex.txHash, null);
});

test("chainIdOf: maps names, passes numeric through", () => {
  assert.equal(kh.chainIdOf("base-sepolia"), "84532");
  assert.equal(kh.chainIdOf("base"), "8453");
  assert.equal(kh.chainIdOf("sepolia"), "11155111");
  assert.equal(kh.chainIdOf("84532"), "84532");
  assert.equal(kh.chainIdOf("weird-name"), "weird-name");
});

test("getStatus: unconfigured returns honest degraded state", async () => {
  const s = await kh.getStatus({ cfg: { ...CFG, apiKey: "" } });
  assert.equal(s.ok, true);
  assert.equal(s.configured, false);
  assert.match(s.note ?? "", /KEEPERHUB_API_KEY/);
  assert.deepEqual(s.lastExecutions, []);
});

test("getStatus: configured fetches org wallet from /api/user", async () => {
  const t = new FakeTransport();
  t.respond(() => ({ status: 200, payload: { data: { address: "0xorgwallet" } } }));
  const s = await kh.getStatus({ cfg: CFG, transport: (url, init) => t.run(url, init), executions: [] });
  assert.equal(s.configured, true);
  assert.equal(s.wallet, "0xorgwallet");
  assert.equal(t.calls[0].url, "https://app.keeperhub.com/api/user");
});

const EXE: import("./keeperhub.ts").KeeperhubExecution = {
  executionId: "kh-x1", chain: "base-sepolia", amountUsd: 5, from: "0xorg",
  to: "0xdst", txHash: "0xabc", txLink: "https://sepolia.basescan.org/tx/0xabc",
  status: "success", executedAt: 1750000000000,
};

test("transferUsdc: SSE stream response is parsed to success", async () => {
  const t = new FakeTransport();
  t.respond(() => mcpOk({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
  t.respond(() => ({ status: 202, payload: {} }));
  t.respond(() => ({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    text: 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"txHash\\":\\"0xsse\\",\\"status\\":\\"success\\"}"}]}}\n\n',
  }));
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "success");
  assert.equal(ex.txHash, "0xsse");
});

test("transferUsdc: unparseable response fails loudly, never 'submitted'", async () => {
  const t = new FakeTransport();
  t.respond(() => mcpOk({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
  t.respond(() => ({ status: 202, payload: {} }));
  t.respond(() => ({ status: 200, headers: { "Content-Type": "application/json" }, failJson: true, text: "<html>gateway error</html>" }));
  const ex = await kh.transferUsdc({
    amountUsd: 5, to: "0xdst", idempotencyKey: "k1", cfg: CFG, transport: (url, init) => t.run(url, init),
  });
  assert.equal(ex.status, "failed");
  assert.match(ex.error ?? "", /unparseable/);
});

test("getConfig: malformed max-stake env falls back to 25", () => {
  process.env.KEEPERHUB_MAX_STAKE_USD = "abc";
  try {
    assert.equal(kh.getConfig().maxStakeUsd, 25);
  } finally {
    delete process.env.KEEPERHUB_MAX_STAKE_USD;
  }
});

test("attachKeeperhubExecution: writes back to open ledger entry", async () => {
  const { promises: fs } = await import("node:fs");
  const dataDir = path.join(tmpRoot, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const entry = {
    id: "e1", symbol: "BTC-x", asset: "BTC", side: "YES", stakePct: 0.2, stake: 5,
    shares: 9, entryPrice: 0.5, openAt: 1, expiresAtMs: 2, refPrice: null, refKind: null,
    status: "open", closeAt: null, win: null, pnl: null,
  };
  await fs.writeFile(path.join(dataDir, "paper-ledger.json"), JSON.stringify({ entries: [entry] }));
  const updated = await paper.attachKeeperhubExecution("e1", EXE);
  assert.ok(updated);
  assert.equal(updated.keeperhub!.executionId, "kh-x1");
  assert.equal(updated.keeperhub!.txLink, EXE.txLink);
  const raw = JSON.parse(await fs.readFile(path.join(dataDir, "paper-ledger.json"), "utf8"));
  assert.equal(raw.entries[0].keeperhub.txHash, "0xabc");
  assert.equal(await paper.attachKeeperhubExecution("nope", EXE), null);
});
