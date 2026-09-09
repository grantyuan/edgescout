#!/usr/bin/env node
// signal-trigger.mjs - unattended "webhook-shaped" trigger for the KeeperHub
// execution layer. Scans open paper positions and executes (or simulates) the
// KeeperHub transfer for every position that has not been executed yet.
//
// This is the automation counterpart of the dashboard's
// "execute on-chain via KeeperHub" button: any caller (cron, webhook, script)
// can fire the same POST /api/keeperhub path, so the EdgeScout -> KeeperHub
// pipeline runs with zero human clicks once the org is funded.
//
// Usage:
//   node scripts/signal-trigger.mjs [--dry-run] [--all]
//     --dry-run  print what would be executed; call nothing
//     --all      execute every pending open position (default: first only)
// Requires: server up (default http://127.0.0.1:3111), KEEPERHUB_API_KEY in .env.
// Safety: KEEPERHUB_DRY_RUN=true in .env forces simulate mode; entries that
// already carry a keeperhub execution are skipped; the server-side
// idempotency key (edgescout-<entryId>-execute) prevents double-spend on retry.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.EDGE_SCOUT_URL || "http://127.0.0.1:3111").replace(/\/$/, "");
const DRY = process.argv.includes("--dry-run");
const ALL = process.argv.includes("--all");

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
const DRY_RUN_ENV = env.KEEPERHUB_DRY_RUN === "true" || env.KEEPERHUB_DRY_RUN === "1";

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

const status = await api("GET", "/api/keeperhub");
if (!status.configured) {
  if (DRY) {
    console.log(`[dry-run] server not configured yet (no KEEPERHUB_API_KEY); listing pending positions only.`);
  } else {
    console.error("ERROR: /api/keeperhub reports configured=false. Set KEEPERHUB_API_KEY in .env (Q1/Q2) and restart the server.");
    process.exit(2);
  }
}
if (!DRY && !env.KEEPERHUB_API_KEY) {
  console.error("ERROR: KEEPERHUB_API_KEY not set in .env (see .env.example).");
  process.exit(1);
}
const paper = await api("GET", "/api/paper");
// open entries nest under .entry in /api/paper; normalize to flat entry objects
const open = (paper.account?.open ?? []).map((o) => o.entry || o);
const pending = open.filter((e) => !e.keeperhub);
if (pending.length === 0) {
  console.log(`OK: no pending open positions (${open.length} open, all already executed).`);
  process.exit(0);
}
const mode = DRY_RUN_ENV ? "simulate" : "execute";
const targets = ALL ? pending : pending.slice(0, 1);

for (const entry of targets) {
  const line = `symbol=${entry.symbol} stake=${entry.stake} mode=${mode} entry=${entry.id}`;
  if (DRY) {
    console.log(`[dry-run] would POST /api/keeperhub { symbol: "${entry.symbol}", mode: "${mode}" } - ${line}`);
    continue;
  }
  try {
    const r = await api("POST", "/api/keeperhub", { symbol: entry.symbol, mode });
    const ex = r.execution ?? {};
    console.log(`OK: ${line}\n    status=${ex.status} tx=${ex.txHash ?? "-"} link=${ex.txLink ?? "-"}`);
    if (!ALL && !r.ok) break;
  } catch (e) {
    console.error(`FAIL: ${line} -> ${e instanceof Error ? e.message : String(e)}`);
    if (!ALL) process.exit(1);
  }
}
console.log(`Done. pending=${pending.length} processed=${DRY ? 0 : targets.length}${DRY ? " (dry-run)" : ""}`);
