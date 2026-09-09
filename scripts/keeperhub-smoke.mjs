#!/usr/bin/env node
// keeperhub-smoke.mjs - end-to-end smoke test for the KeeperHub execution layer.
// Exercises the real submission path against a running EdgeScout server:
//   status -> pick/open a paper position -> simulate -> execute -> evidence JSON.
// Requires: server up (default http://127.0.0.1:3111), KEEPERHUB_API_KEY in .env.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.EDGE_SCOUT_URL || "http://127.0.0.1:3111").replace(/\/$/, "");

function readEnv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const env = readEnv();
if (!env.KEEPERHUB_API_KEY) {
  console.error("ERROR: KEEPERHUB_API_KEY not set in .env (see .env.example).");
  process.exit(1);
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const out = { at: new Date().toISOString(), base: BASE, steps: [] };
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    out.steps.push({ name, ok: true, ms: Date.now() - t0, result: r });
    console.log(`[OK ] ${name} (${Date.now() - t0}ms)`);
    return r;
  } catch (e) {
    out.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message || e) });
    console.log(`[ERR] ${name}: ${e.message || e}`);
    throw e;
  }
};

try {
  await step("status", async () => {
    const s = await api("GET", "/api/keeperhub");
    if (!s.configured) throw new Error("server says keeperhub not configured");
    return { wallet: s.wallet, chain: s.chain, maxStakeUsd: s.maxStakeUsd, dryRun: s.dryRun };
  });

  // pick a market with an executable suggestion; open a paper position if none open for it
  const market = await step("pick market", async () => {
    const paper = await api("GET", "/api/paper");
    const open = (paper.account?.open || []).map((o) => o.entry);
    if (open.length > 0) {
      const e = open[open.length - 1];
      return { symbol: e.symbol, reused: e };
    }
    const m = await api("GET", "/api/markets");
    // Markets rotate every ~5m and the list is cached - walk the executable
    // candidates (biggest edge first) until one accepts a paper open.
    const candidates = (m.markets || [])
      .filter((x) => x.active && x.suggestion && x.suggestion.action !== "SKIP" && (x.suggestion.positionPct ?? 0) > 0.01)
      .sort((a, b) => (b.suggestion.positionPct ?? 0) - (a.suggestion.positionPct ?? 0));
    if (candidates.length === 0) throw new Error("no market with an executable suggestion right now - wait for a 5m window and retry");
    for (const cand of candidates) {
      let opened;
      try {
        opened = await api("POST", "/api/paper/open", { symbol: cand.symbol });
      } catch (e) {
        // Expired/vanished markets reject with HTTP errors - walk on.
        console.log(`[warn] open rejected for ${cand.symbol} (${String(e.message || e).slice(0, 120)}) - trying next candidate`);
        continue;
      }
      const openArr = opened?.account?.open || [];
      const last = openArr[openArr.length - 1];
      const entry = last && (last.entry?.symbol === cand.symbol || last.symbol === cand.symbol) ? (last.entry ?? last) : null;
      if (entry) return { symbol: cand.symbol, opened: entry };
      console.log(`[warn] open rejected for ${cand.symbol} (${opened?.error ?? "no entry"}) - trying next candidate`);
    }
    throw new Error("no market accepted a paper open (all expired?) - wait for a 5m window and retry");
  });

  const sim = await step("simulate", async () => {
    const r = await api("POST", "/api/keeperhub", { symbol: market.symbol, mode: "simulate" });
    if (!r.execution) throw new Error("no execution returned");
    return { status: r.execution.status, amountUsd: r.execution.amountUsd, error: r.execution.error || null };
  });
  if (sim.status !== "simulated" && sim.status !== "submitted") {
    throw new Error("simulate did not pass: " + JSON.stringify(sim));
  }

  const exec = await step("execute", async () => {
    const r = await api("POST", "/api/keeperhub", { symbol: market.symbol, mode: "execute" });
    if (!r.execution) throw new Error("no execution returned");
    if (r.execution.status !== "success") throw new Error("execution not successful: " + JSON.stringify(r.execution));
    return {
      txHash: r.execution.txHash,
      txLink: r.execution.txLink,
      amountUsd: r.execution.amountUsd,
      chain: r.execution.chain,
      explorer: r.execution.txLink || null,
    };
  });

  // The server-side double-spend guard: a second execute for the same
  // position must be rejected (409 / "already executed"). If this ever
  // returns success, the guard is broken - fail the smoke loudly.
  await step("replay guard (expect 409)", async () => {
    try {
      await api("POST", "/api/keeperhub", { symbol: market.symbol, mode: "execute" });
      throw new Error("re-execute returned 200 - 409 double-spend guard is broken");
    } catch (e2) {
      const msg = String(e2.message || e2);
      if (!/409|already executed/i.test(msg)) throw new Error("unexpected replay response: " + msg);
      return { blocked: true, message: msg.slice(0, 140) };
    }
  });

  const ledger = await step("ledger write-back", async () => {
    const paper = await api("GET", "/api/paper");
    const norm = (o) => o.entry || o; // open entries nest under .entry; settled are flat
    const e = (paper.account?.open || []).map(norm).find((x) => x.symbol === market.symbol)
      || (paper.account?.settled || []).find((o) => o.symbol === market.symbol);
    if (!e?.keeperhub?.txHash) throw new Error("paper entry has no keeperhub.txHash after execute");
    return { entryId: e.id, txHash: e.keeperhub.txHash };
  });

  out.evidence = { market: market.symbol, sim, exec, ledger };
  out.passed = true;
  console.log(`\nSMOKE PASS. tx: ${exec.txLink || exec.txHash}`);
  console.log("Evidence: .attestcoin/keeperhub-evidence.json");
} catch (e) {
  out.passed = false;
  console.log("\nSMOKE FAIL:", e.message || e);
} finally {
  mkdirSync(path.join(ROOT, ".attestcoin"), { recursive: true });
  const p = path.join(ROOT, ".attestcoin", "keeperhub-evidence.json");
  writeFileSync(p, JSON.stringify(out, null, 2));
  process.exit(out.passed === true && out.steps.every((s) => s.ok) ? 0 : 1);
}
