# KeeperHub Execution Layer - Technical Integration

How EdgeScout uses [KeeperHub](https://app.keeperhub.com) as its on-chain execution
layer for the **KeeperHub - The Agent Economy** integration.

## 1. Design

EdgeScout's deterministic 1/4-Kelly model produces a sizing signal for a live
Somnia-testnet event-contract market. That signal first fills a **paper
position** (simulated, no chain orders). The KeeperHub execution layer mirrors
the open paper position with a real **testnet USDC transfer on Base Sepolia**
executed by KeeperHub from the org wallet, and writes the resulting transaction
link back into the paper ledger entry (`entry.keeperhub`).

Why this design:

- EdgeScout's analysis venue (Somnia testnet) and KeeperHub's execution chain
  (Base Sepolia) are separate testnets; the paper ledger is the join point.
- The transfer amount equals the position's 1/4-Kelly stake (capped by
  `KEEPERHUB_MAX_STAKE_USD`, default 25), so every on-chain move is auditable
  against the deterministic model output.
- Idempotency keys are derived from the ledger entry id + mode, so re-clicking
  the execute button never double-spends.

## 2. API surface

### `GET /api/keeperhub`

Status with a 60-second in-memory cache:

```json
{
  "ok": true,
  "configured": false,
  "chain": "base-sepolia",
  "usdc": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "maxStakeUsd": 25,
  "dryRun": false,
  "wallet": null,
  "lastExecutions": [],
  "note": "Set KEEPERHUB_API_KEY in .env (org key, starts with kh_) to enable on-chain execution."
}
```

Honest degraded state: without an API key the route returns HTTP 200 with
`configured: false` and a note - never a hard error. With a key it resolves the
org wallet address from KeeperHub's user API and shows the last five executions
collected from the paper ledger.

### `POST /api/keeperhub` - `{ symbol, mode?: "simulate" | "execute" }`

1. Resolve the live market for `symbol` (404 if it no longer exists).
2. Find the **most recent open paper position** for that symbol (400 if none).
3. Size the transfer: `min(position.stake, KEEPERHUB_MAX_STAKE_USD)` rounded to
   2 decimals (400 if it rounds to zero).
4. Resolve the recipient: `to` from the body (override, testing) or the org
   wallet from KeeperHub (502 if unresolvable).
5. Call KeeperHub MCP `execute_transfer` with `simulate: true` when
   `mode === "simulate"` or `KEEPERHUB_DRY_RUN=true`.
6. On success write the execution back to the ledger entry via
   `attachKeeperhubExecution` and return `{ ok: true, execution, entry }`.

Error mapping: 400 (bad body / no open position / zero stake), 404 (market
gone), 409 (KeeperHub not configured, or the position already has a
recorded on-chain execution), 502 (KeeperHub unreachable or transfer
failed - the failed `execution` object is returned for inspection).

## 3. Execution surface (MCP primary, REST fallback)

`src/lib/keeperhub.ts` uses KeeperHub's documented dual surface:

**Primary - MCP JSON-RPC** over streamable HTTP to `{KEEPERHUB_API_BASE}/mcp`
with `Authorization: Bearer kh_...`:

1. `initialize` (protocolVersion 2025-06-18) - capture `Mcp-Session-Id`.
2. `notifications/initialized`.
3. `tools/call execute_transfer` with the documented argument names:
   `chain_id` (numeric string, e.g. `"84532"` via `chainIdOf`), `to_address`,
   `token_address` (USDC), `amount` (human-readable, e.g. `"25.00"`),
   `idempotency_key`, `simulate`.

**Fallback - REST Direct Execution** to
`POST {KEEPERHUB_API_BASE}/api/execute/transfer` with the documented body
`{ chainId, recipientAddress, tokenAddress, amount, simulate? }` and the
`Idempotency-Key` header. It runs on any MCP failure (transport error, session
reset, unparseable response). Because the SAME idempotency key is sent on both
surfaces, a fallback after a partially-completed MCP call dedupes on the
KeeperHub server instead of double-spending. If both surfaces fail, the error
message carries both reasons.

All transport is injectable (`Transport` type), so the full unit test suite
runs offline against a fake transport. Result parsing is defensive: it walks
both `structuredContent` and text content parts and picks up the transaction
hash / link / status / execution id / success / wouldRevert under the common
key spellings. A 2xx response with no execution evidence (empty payload) is
reported as `failed`, never as `submitted`; a terminal `status: "failed"`
without a hash (e.g. spend-cap breach) is likewise reported as `failed`.

## 4. Dashboard integration

- **KeeperPanel** (`src/components/KeeperPanel.tsx`): CONNECTED / NOT
  CONFIGURED badge, org wallet, USDC token, stake cap, mode, and the five most
  recent executions with on-chain links.
- **Open positions table** (`src/app/page.tsx`): new **On-chain** column with
  an `execute on-chain via KeeperHub` button per position; after a successful
  run the cell becomes a link to the Base Sepolia transaction.

## 5. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KEEPERHUB_API_KEY` | *(empty)* | Org API key (`kh_...`); empty = configured-off state |
| `KEEPERHUB_API_BASE` | `https://app.keeperhub.com` | Console base URL |
| `KEEPERHUB_CHAIN` | `base-sepolia` | KeeperHub chain id for execution |
| `KEEPERHUB_USDC` | `0x036CbD...CF7e` | USDC contract on Base Sepolia |
| `KEEPERHUB_MAX_STAKE_USD` | `25` | Hard cap per single execution |
| `KEEPERHUB_DRY_RUN` | `false` | Force simulate preflight only |

## 6. Security properties

- No private key ever enters the EdgeScout codebase; KeeperHub custodies the
  org wallet and EdgeScout only asks for transfers via its API key.
- Amounts are capped server-side (`KEEPERHUB_MAX_STAKE_USD`).
- Idempotency keys (MCP: argument + `Idempotency-Key` header; REST: header
  only, since the REST body has no idempotency field) prevent double-spends on
  retry; the server route additionally rejects re-execution of a ledger entry
  that already has a recorded on-chain execution (tx hash) with HTTP 409.
- Simulations gate execution: the preflight only proceeds when KeeperHub
  reports `success` and not `wouldRevert`; a failed simulation surfaces as
  `failed`, never `simulated`.
- Testnet only: Base Sepolia USDC, no value.
- The API key must never be committed; `.env` is git-ignored and the gate
  script checks that it is present locally without ever printing it.

## 7. Verification

- `src/lib/keeperhub.test.ts`: 20 offline unit tests (config, sizing,
  chain-id mapping, result parsing, MCP handshake, simulate/live paths, auth
  failures, REST fallback, terminal-failure and empty-payload guards, status,
  ledger write-back) - part of the repo's full `npm test` suite.
- End-to-end smoke: `node scripts/keeperhub-smoke.mjs` (requires a configured
  key + funded org wallet; writes `.attestcoin/keeperhub-evidence.json`).
