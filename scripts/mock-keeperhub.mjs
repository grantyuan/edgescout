#!/usr/bin/env node
// Mock KeeperHub server for end-to-end integration testing of EdgeScout's
// execution layer. Emulates the documented dual surface:
//   POST /mcp  (JSON-RPC: initialize, notifications/initialized, tools/call execute_transfer)
//              - documented argument names: chain_id, to_address, token_address, amount, idempotency_key, simulate
//   POST /api/execute/transfer (REST Direct Execution API)
//              - documented body: chainId, recipientAddress, tokenAddress, amount, simulate
//              - Idempotency-Key header dedupes: same key -> same txHash
//   GET /api/user (org wallet) and GET /api/chains (public chain list)
// Logs every request to /tmp/mock-kh.log.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const LOG = "/tmp/mock-kh.log";
const log = (s) => appendFileSync(LOG, s + "\n");
const SEEN = new Map(); // idempotencyKey -> txHash (shared by MCP + REST surfaces)
let execSeq = 0;

function txFor(key) {
  if (!SEEN.has(key)) {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    SEEN.set(key, "0xmock" + h.toString(16).padStart(8, "0").repeat(4).slice(0, 24));
  }
  return SEEN.get(key);
}

createServer(async (req, res) => {
  let chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = req.url || "";
  const auth = req.headers["authorization"] || "none";

  if (req.method === "GET" && url.startsWith("/api/user")) {
    log(`GET /api/user auth=${auth}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { wallet: "0x0000000000000000000000000000000000000001" } }));
    return;
  }

  if (req.method === "GET" && url.startsWith("/api/chains")) {
    log("GET /api/chains");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ chainId: 84532, name: "Base Sepolia", isTestnet: true, isEnabled: true, explorerUrl: "https://sepolia.basescan.org" }] }));
    return;
  }

  // REST Direct Execution surface (documented field names).
  if (req.method === "POST" && url.startsWith("/api/execute/transfer")) {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* empty */ }
    const key = req.headers["idempotency-key"] || body.idempotencyKey || "(none)";
    log(`REST transfer key=${key} auth=${auth} body=${raw}`);
    if (!auth.toLowerCase().startsWith("bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing Bearer API key" }));
      return;
    }
    const txHash = txFor(key);
    if (body.simulate) {
      const payload = { executionId: `direct_sim_${++execSeq}`, status: "simulated", success: true, wouldRevert: false, chainId: body.chainId, tokenAddress: body.tokenAddress, recipientAddress: body.recipientAddress };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    const payload = { executionId: `direct_${++execSeq}`, status: "completed", transactionHash: txHash, transactionLink: `https://sepolia.basescan.org/tx/${txHash}`, chainId: body.chainId, tokenAddress: body.tokenAddress, recipientAddress: body.recipientAddress };
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === "POST" && url.startsWith("/mcp")) {
    let msg;
    try { msg = JSON.parse(raw); } catch { msg = null; }
    if (!msg) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }
    const sess = req.headers["mcp-session-id"];

    if (msg.method === "initialize") {
      log(`MCP initialize protocol=${msg.params?.protocolVersion} auth=${auth}`);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "mock-session-42" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-keeperhub", version: "0.1.0" },
        },
      }));
      return;
    }
    if (msg.method === "notifications/initialized") {
      log(`MCP notifications/initialized session=${sess}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    if (msg.method === "tools/call") {
      // Fault injection: if /tmp/mock-kill-mcp exists, fail tools/call with 500
      // so the client's REST fallback path is exercised end-to-end.
      let killMcp = false;
      try {
        killMcp = (await import("node:fs")).existsSync("/tmp/mock-kill-mcp");
      } catch { killMcp = false; }
      if (killMcp) {
        log("MCP tools/call -> forced 500 (fault injection)");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forced MCP outage" }));
        return;
      }
      const args = msg.params?.arguments ?? {};
      // Documented MCP argument names; keep camelCase as a tolerant fallback.
      const key = args.idempotency_key || args.idempotencyKey || "(none)";
      log(`MCP tools/call ${msg.params?.name} session=${sess} auth=${auth} args=${JSON.stringify(args)}`);
      const txHash = txFor(key);
      if (args.simulate) {
        const payload = { simulation: true, success: true, wouldRevert: false, status: "simulated", chain_id: args.chain_id, token_address: args.token_address, to_address: args.to_address, amount: args.amount };
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "mock-session-42" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload },
        }));
        return;
      }
      const payload = {
        transactionHash: txHash,
        transactionLink: `https://sepolia.basescan.org/tx/${txHash}`,
        status: "success",
        chain_id: args.chain_id,
        token_address: args.token_address,
        to_address: args.to_address,
        amount: args.amount,
      };
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "mock-session-42" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload },
      }));
      return;
    }
    log(`MCP unknown method ${msg.method} auth=${auth}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}).listen(9999, "127.0.0.1", () => log("mock-keeperhub listening on 127.0.0.1:9999 (dual surface)"));
