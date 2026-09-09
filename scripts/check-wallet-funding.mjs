#!/usr/bin/env node
// check-wallet-funding.mjs - verify the KeeperHub org wallet holds enough Base
// Sepolia testnet funds before a real execution smoke run.
//
// Usage:
//   node scripts/check-wallet-funding.mjs [--wallet 0x...]
// Without --wallet the org wallet is read from GET /api/keeperhub on the local
// EdgeScout server (requires KEEPERHUB_API_KEY in .env and the server up).
//
// Checks: native ETH balance (gas) and USDC (6 decimals) on Base Sepolia,
// read-only via JSON-RPC against https://sepolia.base.org.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function readEnv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = readEnv();
const RPC = "https://sepolia.base.org";
const USDC = env.KEEPERHUB_USDC || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MIN_USDC = 5;
const arg = process.argv.indexOf("--wallet");

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(method + " -> " + JSON.stringify(j.error));
  return j.result;
}

let wallet = arg !== -1 ? process.argv[arg + 1] : null;
if (!wallet) {
  const base = (process.env.EDGE_SCOUT_URL || "http://127.0.0.1:3111").replace(/\/$/, "");
  const st = await (await fetch(base + "/api/keeperhub")).json();
  if (!st.configured) {
    console.error("ERROR: server not configured (no KEEPERHUB_API_KEY in .env). Pass --wallet 0x... instead.");
    process.exit(1);
  }
  wallet = st.wallet;
}
if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || "")) {
  console.error("ERROR: could not resolve a 0x40-hex org wallet.");
  process.exit(1);
}

const [eth, usdc] = await Promise.all([
  rpc("eth_getBalance", [wallet, "latest"]),
  rpc("eth_call", [{ to: USDC, data: "0x70a08231" + wallet.slice(2).padStart(64, "0") }, "latest"]),
]);
const ethGwei = Number(BigInt(eth)) / 1e9;
const usdcUsd = Number(BigInt(usdc)) / 1e6;

console.log("org wallet :", wallet);
console.log("chain      : Base Sepolia (84532) via " + RPC);
console.log("ETH (gas)  : " + ethGwei.toFixed(4) + " gwei");
console.log("USDC       : " + usdcUsd.toFixed(4) + " USD (testnet)");
if (usdcUsd >= MIN_USDC) {
  console.log("OK: wallet is funded (" + usdcUsd.toFixed(2) + " testnet USDC >= " + MIN_USDC + ")." +
    " Run the real smoke: node scripts/keeperhub-smoke.mjs");
  process.exit(0);
}
console.log("NOT FUNDED: top up testnet USDC + a little testnet ETH (FREE testnet faucets):");
console.log("  - USDC: https://faucet.circle.com  (Base Sepolia) -> " + wallet);
console.log("  - ETH : https://portal.cdp.coinbase.com/products/faucet or https://www.alchemy.com/faucets (Base Sepolia)");
process.exit(2);
