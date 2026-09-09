# ASC Integration — How EdgeScout Uses the Attestcoin Protocol

> Technical documentation for how EdgeScout integrates the **Attestcoin Protocol**
> (Creditcoin CC3 testnet) as a verified, read-only on-chain data channel.
>
> Everything below is read-only, key-free, and reproducible in under two minutes
> (see [§5 Reproduce](#5-reproduce)). All endpoints and addresses were verified live on
> **2026-08-31** against Creditcoin CC3 testnet and the official proof-builder service.

---

## 1. Overview

**EdgeScout** is an AI analyst for binary event contracts. Its core design rule is that
**the LLM never produces a number**: fair value, implied probability, edge and position size are
computed by deterministic, unit-tested code (72 passing tests), and the language model only
narrates those numbers, with a deterministic template fallback.

That design has one hard dependency: **every input number must be trustworthy**. Prices and
signals that reach an autonomous agent are exactly where a centralized oracle becomes a single
point of failure — if the feed lies, the model is confidently, deterministically wrong.

The Attestcoin Protocol removes that operator. It is the cross-chain interoperability hub on
Creditcoin (CC3) with its own decentralized oracle infrastructure: a staked set of **attestors**
reaches consensus on source-chain blocks and stores attestations on Creditcoin, and any contract
or caller can then prove that a specific source-chain transaction is included in an attested block
using **Merkle + continuity proofs**, checked synchronously by the **Block Prover Precompile**
(`0x0FD2`) — no callback, no relay signature to trust, no oracle operator.
(Source: https://docs.attestcoin.org/attestcoin-protocol.md ,
https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability.md)

EdgeScout uses this as a **verified on-chain data channel** feeding its signal stack:

| Layer | What it is | Trust basis |
|---|---|---|
| Market data | DreamDEX binary event contracts on Somnia testnet, streamed via the official `@somnia-chain/markets-sdk` | public testnet order books, read-only |
| **Attested signal channel** | **Sepolia source transactions proved into an attested block on Creditcoin CC3 via the Attestcoin Block Prover Precompile** | **attestor consensus + Merkle proof + continuity proof, verified on-chain** |
| Model | Zero-drift Brownian fair value `P(S_T >= K) = Phi(ln(S/ref) / (sigma*sqrt(tau)))`, sigma from 60 one-minute candles | deterministic, 72 unit tests |
| Narration | LLM report, numbers injected, never generated | deterministic fallback |

### 1.1 Honest scope statement (read this first)

**Somnia is not a supported Attestcoin source chain.** The live
`get_supported_chains()` call on the ChainInfo precompile (`0x0FD3`) returns exactly two
entries on CC3 testnet — Ethereum **Sepolia** (chainKey `1`, chainId `11155111`) and Ethereum
**Mainnet** (chainKey `3`, chainId `1`) — and the official environments page lists the same set
(https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-chains-environments.md).

So EdgeScout does **not** claim to attest DreamDEX/Somnia order books. Instead:

- **Attested signals originate on Sepolia** and are cryptographically verified on Creditcoin CC3.
  This is the exact pattern the official tutorials use (a source-chain contract emits an event;
  the event's transaction is attested and proved on Creditcoin).
- **Primary market data stays Somnia testnet order books** through the official Somnia SDK.
- The two are combined in the same signal stack: an attested, on-chain-verified fact is a
  first-class input alongside book-derived numbers, and the dashboard shows the verification
  status of that channel explicitly rather than asking the user to trust it.

We state this openly because the alternative — implying Somnia data is attested — would be false.
The roadmap for closing the gap is in [§8 Limitations & roadmap](#8-limitations--roadmap).

---

## 2. Architecture

```
        SOURCE CHAIN                     ATTESTCOIN / CREDITCOIN CC3                 EDGESCOUT (Next.js 16)
 ┌───────────────────────┐        ┌───────────────────────────────────┐        ┌───────────────────────────┐
 │ Ethereum Sepolia      │        │  Attestors reach consensus on     │        │  src/lib/attest.ts        │
 │ chainKey 1            │  ────▶ │  Sepolia blocks and store the     │        │  (read-only client)       │
 │ chainId 11155111      │ attest │  attestation on Creditcoin CC3    │        │                           │
 │                       │        │  (chainId 102031)                 │        │  GET /api/attest          │
 │ signal / event tx     │        └───────────────────────────────────┘        │        │                  │
 │ 0x<txHash>            │                                                     │        ▼                  │
 └───────────┬───────────┘        ┌───────────────────────────────────┐        │  Dashboard panel          │
             │                    │ (1) Proof builder (free HTTP)     │        │  "Attestcoin Attestations"│
             └───── txHash ─────▶ │ prover.cc3-testnet.creditcoin...  │ ─────▶ │  ✔ VERIFIED ON-CHAIN      │
                                  │ /api/v1/proof-by-tx/{key}/{tx}    │  proof │  source chain / height    │
                                  │  → txBytes, merkleProof,          │        │  txHash / merkleRoot      │
                                  │    continuityProof, headerNumber  │        │  continuity blocks        │
                                  └────────────────┬──────────────────┘        └───────────────────────────┘
                                                   │ proof                                  ▲
                                                   ▼                                        │ verified: true/false
                                  ┌───────────────────────────────────┐                     │
                                  │ (2) Block Prover Precompile 0x0FD2│ ────────────────────┘
                                  │     eth_call verify(...) → bool   │
                                  │     (stateless, free, no key)     │
                                  └────────────────┬──────────────────┘
                                                   │ verified tx bytes
                                                   ▼
                                  ┌───────────────────────────────────┐
                                  │ (3) EvmV1Decoder library          │
                                  │  0x731c345d79Fb8BbDC541f9DF3b63…  │
                                  │  → tx type, receipt status, logs  │
                                  └───────────────────────────────────┘
```

Flow in words:

1. **Source transaction (Sepolia).** A transaction on Sepolia carries the signal we care about
   (an event log from a signal-emitting source contract, or any existing Sepolia transaction whose
   event is relevant). Its hash is the only input EdgeScout needs.
2. **Proof (free HTTP).** EdgeScout asks the official hosted proof builder for the Merkle proof and
   the continuity proof binding that transaction's block to an attested checkpoint:
   `GET https://prover.cc3-testnet.creditcoin.network/api/v1/proof-by-tx/1/{txHash}`.
   The response carries `chainKey`, `headerNumber`, `txIndex`, `txBytes`,
   `merkleProof {root, siblings[]}` and `continuityProof {lowerEndpointDigest, roots[]}`.
3. **On-chain verification (free `eth_call`).** EdgeScout calls `verify(...)` on the **Block
   Prover Precompile** `0x0000000000000000000000000000000000000FD2` over the CC3 testnet RPC.
   This is a stateless `eth_call` — **no private key, no gas, no funds** — and returns a boolean:
   *is this transaction genuinely included in a block that Creditcoin's attestors attested?*
4. **Decode.** The verified `txBytes` are decoded (EVM v1 decoder: transaction type, receipt
   status, event logs) so the signal's values, not just its existence, are usable. Per the official
   ASC documentation the precompile proves **inclusion only**, so the consumer must additionally
   check **receipt status == 1** before acting on the transaction — EdgeScout does this in the
   decode step.
5. **Consume.** `GET /api/attest` returns the normalized result; the dashboard renders the
   **Attestcoin Attestations** panel with a `VERIFIED ON-CHAIN` badge, the source chain,
   attested block height, transaction hash, Merkle root and continuity-proof block count. The
   verified fact enters EdgeScout's signal stack next to the deterministic book-derived numbers.

### 2.1 Exact endpoints and addresses (live-verified 2026-08-31)

| Purpose | Value |
|---|---|
| Creditcoin CC3 testnet JSON-RPC (`eth_call`, reads) | `https://rpc.cc3-testnet.creditcoin.network` |
| CC3 testnet EVM chain id | `102031` (`eth_chainId` → `0x18e8f`) |
| Proof builder — proof by tx | `https://prover.cc3-testnet.creditcoin.network/api/v1/proof-by-tx/{chainKey}/{txHash}` |
| Proof builder — attested height | `https://prover.cc3-testnet.creditcoin.network/api/v1/attested-height/{chainKey}` |
| **Block Prover Precompile** (`verify`) | `0x0000000000000000000000000000000000000FD2` |
| ChainInfo precompile (supported chains, attestation height) | `0x0000000000000000000000000000000000000FD3` |
| EvmV1Decoder library (CC3 testnet) | `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` |
| Block explorer (Blockscout) | `https://creditcoin-testnet.blockscout.com/` |
| ASC dashboard | `https://dashboard.cc3-testnet.creditcoin.network/` |
| Source chain used by EdgeScout | Ethereum **Sepolia**, chainKey `1`, chainId `11155111` |
| Also attested on CC3 testnet | Ethereum **Mainnet**, chainKey `3`, chainId `1` |
| Testnet CTC faucet (only needed for the write path) | Creditcoin Discord `https://discord.gg/creditcoin` → `#token-faucet`, ~100 tCTC / 24h |
| **EdgeScout ASC** (`EdgeScoutSignalStore`) on CC3 testnet | `[ASC_ADDRESS]` — code complete, deployment pending funds; see [§6](#6-on-chain-asc-edgescoutsignalstore) |

Precompile ABI used for verification (from the official SDK, confirmed by the live call):

```
verify(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[])) returns (bool)
      chainKey headerNumber txBytes  merkleProof{root,siblings}  continuityProof{lowerEndpoint,roots}
```

Libraries: `@gluwa/usc-sdk` (v0.18.0, TypeScript, `ethers@^6` peer) and — for the planned own-ASC
deployment — `@gluwa/usc-contracts` (v0.2.0, Solidity source for Foundry).
(https://www.npmjs.com/package/@gluwa/usc-sdk , https://www.npmjs.com/package/@gluwa/usc-contracts)

---

## 3. Implementation in EdgeScout

| Artifact | Role |
|---|---|
| `src/lib/attest.ts` | Attestcoin client: resolves supported chains, fetches the proof from the prover API, runs the `eth_call` verification against `0x0FD2`, normalizes the result. Read-only: no wallet, no private key, no signing path exists in the module. |
| `GET /api/attest` | Next.js route exposing that pipeline as JSON (contract in [§4](#4-api-contract)). Optional `?txHash=` selects the source transaction; without it the route uses the configured default attested transaction. |
| Dashboard panel *"Attestcoin Attestations"* | Renders the verification result: `VERIFIED ON-CHAIN` badge, source chain (Ethereum Sepolia, chainKey 1), attested block height, transaction hash, Merkle root, continuity-proof block count. |

Operational properties:

- **Zero-key, zero-gas read path.** Proof fetch is plain HTTPS; verification is `eth_call`.
  Reading other chains through Attestcoin is free (https://attestcoin.org/), and the SDK's
  `verifySingle` uses `staticCall` under the hood.
- **Freshness.** Attestation advances roughly per Creditcoin block (~15 s verification window per
  the protocol docs), so the route is dynamic with a short TTL cache rather than statically built.
- **Failure is visible, not silent.** If the prover cannot serve a proof or the verification
  returns false, the response carries `ok`/`verified` flags plus `error`, and the panel shows an
  unverified state. EdgeScout never upgrades an unverified signal into a trusted one — consistent
  with the project's "no invented numbers" rule.
- **Inclusion ≠ success.** Because the precompile proves inclusion only, the decode step checks
  the receipt status before the value is treated as a usable signal.

---

## 4. API contract

### Request

```
GET /api/attest              # default source transaction
GET /api/attest?txHash=0x…   # verify a specific Sepolia transaction
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `txHash` | `0x`-prefixed 32-byte hex string | no | Source-chain (Sepolia) transaction to prove and verify. Omitted → the configured default transaction. |

### Response (`application/json`)

```json
{
  "ok": true,
  "verified": true,
  "sourceChain": { "chainKey": 1, "chainId": 11155111, "name": "Ethereum Sepolia" },
  "blockNumber": 8812893,
  "txHash": "0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1",
  "txIndex": 185,
  "merkleRoot": "0x…",
  "continuityBlocks": 3,
  "attestedHeight": 11606080,
  "fetchedAt": "2026-08-31T00:00:00.000Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | The pipeline ran end to end (proof fetched, verification call executed). |
| `verified` | boolean | **The cryptographic result**: the precompile `0x0FD2` confirmed the transaction is included in a block attested by Creditcoin's attestors. This is the value behind the `VERIFIED ON-CHAIN` badge. |
| `sourceChain` | object | `{ chainKey, chainId, name }` of the attested source chain, resolved from the ChainInfo precompile (`1 / 11155111 / Ethereum Sepolia`). |
| `blockNumber` | number | Source-chain block containing the transaction (the proof's `headerNumber`). |
| `txHash` | string | The proved source-chain transaction hash. |
| `txIndex` | number | Index of that transaction within its block (the Merkle leaf position). |
| `merkleRoot` | string | Merkle root the inclusion proof resolves to. |
| `continuityBlocks` | number | Number of block roots in the continuity proof linking the block to an attested checkpoint. |
| `attestedHeight` | number | Latest attested source-chain height known to the prover for this chainKey — how current the attestation channel is. |
| `fetchedAt` | string (ISO-8601) | When the verification was performed. |
| `error` | string (optional) | Present only on failure (prover unavailable, unknown tx, verification false). `ok` and/or `verified` are then `false`. |

Error shape example:

```json
{ "ok": false, "verified": false, "error": "proof not available for tx (not yet attested)" }
```

---

## 5. Reproduce

Everything here is free and needs **no wallet, no key, no funds**.

### 5.1 Call the deployed EdgeScout endpoint

```bash
# default attested transaction
curl -s "[DEPLOYED_URL]/api/attest" | jq

# a specific Sepolia transaction (the officially attested tutorial tx)
curl -s "[DEPLOYED_URL]/api/attest?txHash=0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1" | jq
```

Expect `"verified": true` with `sourceChain.chainKey = 1`, `chainId = 11155111`.

### 5.2 Verify the same claim yourself, without EdgeScout

```bash
# (a) how current is the attestation channel for Sepolia (chainKey 1)?
curl -s https://prover.cc3-testnet.creditcoin.network/api/v1/attested-height/1

# (b) fetch the Merkle + continuity proof for the transaction
curl -s https://prover.cc3-testnet.creditcoin.network/api/v1/proof-by-tx/1/0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1 | jq

# (c) confirm you are talking to Creditcoin CC3 testnet (expect 0x18e8f = 102031)
curl -s -X POST https://rpc.cc3-testnet.creditcoin.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

### 5.3 ethers.js: call `verify` on the precompile `0x0FD2` directly

```js
// npm i ethers@^6   — read-only, no private key
import { JsonRpcProvider, Contract } from "ethers";

const CC3_RPC       = "https://rpc.cc3-testnet.creditcoin.network"; // chainId 102031
const PROVER        = "https://prover.cc3-testnet.creditcoin.network";
const BLOCK_PROVER  = "0x0000000000000000000000000000000000000FD2";
const CHAIN_KEY     = 1; // Ethereum Sepolia
const TX = "0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1";

const ABI = [
  "function verify(uint64 chainKey, uint64 headerNumber, bytes txBytes," +
  " (bytes32 root,(bytes32 hash,bool isLeft)[] siblings) merkleProof," +
  " (bytes32 lowerEndpointDigest,bytes32[] roots) continuityProof) view returns (bool)",
];

const proof = await (await fetch(`${PROVER}/api/v1/proof-by-tx/${CHAIN_KEY}/${TX}`)).json();

const provider = new JsonRpcProvider(CC3_RPC);
const prover   = new Contract(BLOCK_PROVER, ABI, provider);

// stateless eth_call — costs nothing
const verified = await prover.verify(
  proof.chainKey,
  proof.headerNumber,
  proof.txBytes,
  proof.merkleProof,
  proof.continuityProof,
);

console.log({ verified, block: proof.headerNumber, txIndex: proof.txIndex });
// → { verified: true, ... }
```

The same call is available through the official SDK as
`PrecompileBlockProver.verifySingle(...)` (`@gluwa/usc-sdk`), which wraps the identical
`staticCall`.

### 5.4 Inspect on the explorer

- Creditcoin CC3 testnet Blockscout: **https://creditcoin-testnet.blockscout.com/**
  - EvmV1Decoder library used for decoding: `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f`
  - Official tutorial ASC Minter deployment: `0x2Be9B8640ED32815d3B9e8C92AbcD3F15F07396f`
  - Official tutorial mintable token (bytecode confirmed present via `eth_getCode`):
    `0x914Cf96BF28b7b4921db27b264ecEd71aC91134E`
  - EdgeScout ASC (`EdgeScoutSignalStore`, built and tested; awaiting funds): `[ASC_ADDRESS]`
- ASC dashboard: https://dashboard.cc3-testnet.creditcoin.network/

---

## 6. On-chain ASC (`EdgeScoutSignalStore`)

Everything in §1–§5 is the **read** half of the integration: it proves a Sepolia transaction with a
free `eth_call` and leaves no trace on chain. This section is the **write** half — EdgeScout's own
**ASC (Attestcoin Smart Contract)** on Creditcoin CC3, which turns a verified proof into permanent,
publicly auditable on-chain state.

> **Status (honest).** The contract is **written, compiled and tested** (29 Foundry tests passing,
> plus an end-to-end rehearsal of the deploy and demo scripts against a local chain using a **real
> proof** from the live prover API). It is **not deployed yet**: deployment and the `attestTx`
> transaction are the only steps in this project that cost tCTC, and the deployer wallet
> `0x<DEPLOYER_TESTNET_WALLET>` is still at **0 tCTC** pending the manual Creditcoin
> Discord faucet (~100 tCTC / 24 h). The commands in §6.5 deploy it in one step once funded, and
> `[ASC_ADDRESS]` throughout this document is the placeholder for the resulting address.

### 6.1 What the contract does

`EdgeScoutSignalStore` is a **ledger of verified source-chain facts**. It follows the canonical ASC
pattern from the official ASC documentation exactly:

| Step | In `attestTx(...)` |
|---|---|
| 1. Query identity | `queryId = keccak256(abi.encode(chainKey, headerNumber, txIndex, txHash))` |
| 2. Replay protection | reverts with `QueryAlreadyProcessed` if that `queryId` was ever stored |
| 3. Verification | calls **`verifyAndEmit`** on the Block Prover precompile `0x0FD2` — reverts if the Merkle + continuity proof does not hold |
| 4. Decode | `EvmV1Decoder.decodeReceiptFields(txBytes)` → receipt status, log count, first log topic |
| 5. Business logic | stores a `StoredFact` and emits `SignalStored` |

Two protocol rules are honoured explicitly rather than assumed:

- **Inclusion ≠ success.** The precompile proves only that the transaction is in an attested block.
  The contract therefore checks `receiptStatus == 1` itself and rejects failed source transactions
  (`SourceTransactionFailed`) — a reverted source transaction carries no usable signal.
- **Replay protection is the ASC's job**, not the protocol's; `queryId` is the guard, and it is
  written to storage **before** the external call (checks-effects-interactions), with a
  `nonReentrant` guard so no nested call can take the reserved ledger slot.

The ledger is append-only and capped at **1000 facts** (`SignalStoreFull` when full), which bounds
storage growth and keeps the faucet-funded testnet demo cheap.

### 6.2 Interface

```solidity
// entry point (the only state-changing function; costs tCTC)
function attestTx(
    uint256 chainKey,          // 1 = Ethereum Sepolia on CC3 testnet
    uint256 headerNumber,      // source-chain block height
    uint256 txIndex,           // transaction index in that block
    bytes32 txHash,
    bytes calldata txBytes,    // ABI-encoded tx + receipt, from the prover API
    INativeQueryVerifier.MerkleProof calldata merkleProof,
    INativeQueryVerifier.ContinuityProof calldata continuityProof
) external returns (bytes32 queryId);

// views (free eth_call — what /api/asc reads)
function signalCount() external view returns (uint256);
function signals(uint256 index) external view returns (StoredFact);   // array getter
function latestSignal() external view returns (StoredFact);           // reverts when empty
function factOfQuery(bytes32 queryId) external view returns (StoredFact);
function isProcessed(bytes32 queryId) external view returns (bool);
function precompileAddress() external pure returns (address);         // 0x…0FD2
function computeQueryId(uint256, uint256, uint256, bytes32) external pure returns (bytes32);
function remainingCapacity() external view returns (uint256);
```

`StoredFact` packs the first six fields into a single storage slot
(`64+64+32+32+48+8 = 248` bits), so one fact costs 3 slots instead of 8:

| Field | Type | Meaning |
|---|---|---|
| `chainKey` | `uint64` | Attestcoin source chain (1 = Sepolia) |
| `headerNumber` | `uint64` | source-chain block height |
| `txIndex` | `uint32` | transaction index in that block |
| `logCount` | `uint32` | number of logs in the attested receipt |
| `storedAt` | `uint48` | Creditcoin `block.timestamp` when recorded |
| `receiptStatus` | `uint8` | always `1` (failed receipts are rejected) |
| `txHash` | `bytes32` | source-chain transaction hash |
| `firstLogTopic` | `bytes32` | topic 0 of the first log, or zero |

### 6.3 Files

| Path | Role |
|---|---|
| `contracts/src/EdgeScoutSignalStore.sol` | the ASC itself |
| `contracts/src/SignalEmitter.sol` | **optional** Sepolia-side source contract that emits a `Signal` event; not needed for the default demo (see §6.7) |
| `contracts/test/EdgeScoutSignalStore.t.sol` | 25 tests; the precompile is stubbed **at `0x0FD2` with `vm.etch`**, so the production call path runs unchanged offline |
| `contracts/test/SignalEmitter.t.sol` | 4 tests |
| `contracts/test/BlockProverStub.sol` | accepting / rejecting / reverting / re-entering precompile doubles |
| `scripts/deploy-asc.mjs` | idempotent deployment (ethers v6) |
| `scripts/attest-on-asc.mjs` | the demo: proof → `attestTx` → read state back |
| `src/lib/asc.ts`, `src/app/api/asc/route.ts` | read-only `GET /api/asc` (see §6.8) |

### 6.4 One deviation from the official tutorial, and why

The tutorials deploy `EvmV1Decoder` as a **separate library** and link the ASC against it
(`forge create --libraries …:EvmV1Decoder:<address>`). That does **not** apply to the package this
project actually installs:

- The published npm package `@gluwa/usc-contracts@0.2.0` ships **only** `contracts/write-ability/**`
  — there is no `contracts/decoding/EvmV1Decoder.sol`. The decoder lives at
  **`contracts/write-ability/common/EvmV1Decoder.sol`**, and the precompile interface at
  `contracts/write-ability/common/INativeQueryVerifier.sol`.
- That decoder declares **`internal` functions only**, so solc **inlines** it. The compiled ASC
  artifact contains `linkReferences: {}` — there is nothing to deploy and nothing to link.

We follow the package, not the tutorial text. `scripts/deploy-asc.mjs` does not hard-code either
behaviour: it reads `linkReferences` out of the Foundry artifact and deploys + links a library only
if the compiler asks for one, otherwise it reports `decoderLinkage: "inlined"` and skips the step.
The interface used for `0x0FD2` is the package's own `INativeQueryVerifier`, whose `verify`
signature matches the ABI verified live in §9 exactly.

### 6.5 Build, test, deploy

```bash
# 1. build + test the contracts (offline, no network, no funds)
cd contracts && forge build && forge test && cd ..
#    → Compiler run successful! / 29 tests passed, 0 failed

# 2. deploy to Creditcoin CC3 testnet (needs tCTC)
node scripts/deploy-asc.mjs
```

The deploy script verifies it is talking to chainId `102031`, then **fails loudly on a zero
balance** instead of sending a doomed transaction:

```
✗ deployer is not funded — testnet funds are required to deploy
  Fund it from the Creditcoin testnet faucet (manual, ~100 tCTC per 24h):
    1. Join the Creditcoin Discord:  https://discord.gg/creditcoin
    2. Open the  #token-faucet  channel
    3. Run:  /faucet address:0x<DEPLOYER_TESTNET_WALLET>
```

It is **idempotent**: it records addresses in `.attestcoin/deployed.json` (gitignored, alongside the
throwaway testnet key — neither is ever committed) and on re-run re-checks each address with
`eth_getCode` and skips what already exists.

### 6.6 The demo

```bash
node scripts/attest-on-asc.mjs            # default: the official tutorial burn tx
node scripts/attest-on-asc.mjs 0x<txHash> # any attested Sepolia transaction
node scripts/attest-on-asc.mjs --dry-run  # fetch + verify the query id, send nothing
```

1. fetches the Merkle + continuity proof from the prover API (free HTTP),
2. re-computes `queryId` off-chain and asserts it against the contract's `computeQueryId`,
3. checks `isProcessed(queryId)` first, so a replay never wastes tCTC,
4. sends **`attestTx`** — the one paid step; the ASC calls `0x0FD2` *inside* this transaction,
5. reads `signalCount()` / `latestSignal()` back with `eth_call` and prints clean JSON,
6. prints the **Blockscout transaction link** — the on-chain proof artifact, where the ASC's
   `SignalStored` event appears next to the protocol's own `TransactionVerified` event:
   `https://creditcoin-testnet.blockscout.com/tx/<hash>`

**Rehearsed end to end.** Against a local chain (with the precompile stubbed and a **real** proof
from the live prover API for the tutorial transaction), `attestTx` succeeded using **230,603 gas**
and the decoder produced exactly the values independently decoded during research (§9):
`receiptStatus 1`, `logCount 1`, `firstLogTopic`
`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` (ERC-20 `Transfer`). The
proof for that transaction currently carries **8 Merkle siblings and 108 continuity roots**, which
is why gas grows with transaction age (§8).

### 6.7 The optional Sepolia emitter

`contracts/src/SignalEmitter.sol` is the smallest possible *source-chain smart contract*: one
`emitSignal(bytes32 topic, int256 value)` function emitting a `Signal` event. Attesting **EdgeScout's
own** signal end to end is the natural next step, but deploying it needs **Sepolia ETH** from a
separate faucet — a manual user action. It is therefore **not required for the default demo**, which
attests an existing Sepolia transaction, and `scripts/deploy-asc.mjs` deliberately deploys the
Creditcoin side only.

### 6.8 Reading the ASC from the app — `GET /api/asc`

`src/lib/asc.ts` + `src/app/api/asc/route.ts` read the ASC's state with **`eth_call` only** (no
wallet, no key, no gas; 60 s cache, same pattern as `/api/attest`). Configuration is
`EDGE_SCOUT_ASC_ADDRESS` (and `EVMV1_DECODER_LIB_ADDRESS`, unused while the decoder is inlined) in
`.env`; **empty means "not deployed yet"** and is a supported, non-error state:

```json
{ "ok": true, "deployed": false, "ascAddress": null, "signalCount": null,
  "latestSignal": null, "note": "ASC not deployed yet: set EDGE_SCOUT_ASC_ADDRESS …" }
```

Once deployed and populated:

```json
{ "ok": true, "deployed": true, "ascAddress": "0x…", "evmV1DecoderLib": null,
  "signalCount": 1,
  "latestSignal": { "chainKey": 1, "blockNumber": 8812893, "txIndex": 185,
                    "txHash": "0xbc1aef…f0e1", "receiptStatus": 1, "logCount": 1,
                    "firstLogTopic": "0xddf252ad…b3ef", "storedAt": "2026-…Z" } }
```

The dashboard's *"Attestcoin Attestations"* panel renders this as one extra **On-chain ASC** row —
either `not deployed yet (testnet funds pending)` or `N verified facts stored` — so the panel tells
the truth about deployment state at all times. `src/lib/asc.test.ts` covers this module with 10
offline tests using the same injectable-transport pattern as `attest.ts`.

---

## 7. Trust model — why there is no centralized oracle here

The AI track asks for *"AI apps on Creditcoin that process cryptographically verified cross-chain
data … without centralized oracle operators."* Concretely, this is what replaces the operator:

1. **Attestor consensus, not an operator key.** A decentralized set of staked attestors votes on
   source-chain block state and stores the attestation on Creditcoin. There is no single
   privileged publisher whose key, uptime or honesty the app depends on.
   (https://docs.attestcoin.org/attestcoin-protocol.md)
2. **Merkle inclusion proof.** The claim "this transaction was in that block" is a mathematical
   statement about a Merkle root and its sibling path — checked, not asserted.
3. **Continuity proof.** The block carrying the transaction is chained to an attested checkpoint
   via a sequence of block roots, so an attacker cannot present a valid-looking block that the
   attestors never attested. `continuityBlocks` in our API response is exactly the length of that
   chain.
4. **Verification happens in-protocol, in the same call.** The Block Prover Precompile `0x0FD2` is
   part of the Creditcoin node, so verification is synchronous: no asynchronous oracle callback,
   no "wait for the reporter", no window in which unverified data is treated as verified. Protocol
   docs put verification within one Creditcoin block (~15 s), with batch verification of up to
   10 queries sharing a single continuity proof.
5. **The same check works on-chain and off-chain.** EdgeScout's server performs it via `eth_call`;
   an ASC performs the identical check inside a transaction with `verify`/`verifyAndEmit`. The
   trust assumption does not change between the dashboard and the contract.
6. **What is *not* proved, stated plainly.** The precompile proves **inclusion**, not execution
   success — the receipt status must be checked separately (EdgeScout does this) — and it proves
   nothing about the *semantics* of the emitted values: garbage emitted by a source contract is
   attested garbage. Trust is therefore anchored at the source contract, which is why our roadmap
   deploys our **own** Sepolia signal emitter rather than relying on third-party events.

For EdgeScout the payoff is direct: an autonomous agent that never invents numbers should not
depend on an oracle operator who can. Every attested input can be re-verified by anyone, including
a judge, with the two `curl` commands in §5.2 and the snippet in §5.3.

---

## 8. Limitations & roadmap

### Current limitations (stated honestly)

| Limitation | Detail | Consequence for EdgeScout |
|---|---|---|
| Somnia is not an Attestcoin source chain | `get_supported_chains()` on `0x0FD3` returns only Sepolia (chainKey 1) and Ethereum mainnet (chainKey 3) | DreamDEX/Somnia order books cannot be attested today; attested signals originate on **Sepolia**, while primary market data stays Somnia testnet |
| Inclusion ≠ semantics | The precompile proves a tx is in an attested block; it cannot judge whether the emitted value is meaningful | Trust anchors at the source contract; own emitter planned |
| Attestation lag | Attestation advances per checkpoint; the tutorial observed up to ~8 minutes worst case | Freshly emitted signals need a short wait before they are provable; the panel shows `attestedHeight` so lag is visible |
| Proof size / age | Sparse checkpoints (~every 1000 blocks) mean very old transactions carry long continuity proofs; transactions above ~500 KB are not provable, and on-chain submission gas grows with proof length | Demo attests recent transactions; our `eth_call` read path stays free regardless |
| Write path needs funds | Deploying an ASC and submitting proofs on-chain costs testnet CTC (Discord faucet ~100 tCTC/24h, deliberately high testnet oracle fees) | The read path needs none; the own ASC is code-complete and tested (§6) and deploys in one command once the faucet lands — `attestTx` measured at 230,603 gas |
| Branding drift in upstream docs | The USC → Attestcoin rename is incomplete (npm packages and repos are still `usc-*`; an example `DEPLOY.md` still points at the retired `usc-testnet2` network) | We follow the current chains & environments page and the live example READMEs, not stale URLs |

### Roadmap

1. **Deploy EdgeScout's own ASC on CC3 testnet** (`[ASC_ADDRESS]`) — **built and tested; only the
   deployment transaction is outstanding**, see [§6](#6-on-chain-asc-edgescoutsignalstore).
   `EdgeScoutSignalStore` calls `verifyAndEmit` on `0x0FD2`, enforces replay protection over
   processed query ids, decodes the attested transaction with `EvmV1Decoder` from
   `@gluwa/usc-contracts` (inlined, not linked — §6.4), stores the verified fact on-chain and emits
   `SignalStored`. `GET /api/asc` already reads its view functions with a second free `eth_call`,
   moving from *off-chain verification of attested data* to *on-chain state produced by attested
   data*. Blocked only on the manual Discord faucet.
2. **Deploy an EdgeScout signal emitter on Sepolia** — the official
   "source chain smart contract" pattern
   (https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts.md)
   — so the attested payload is EdgeScout's own market signal, end to end, instead of a
   third-party transaction.
3. **Batch verification** via the SDK's batch proof path (up to 10 transactions sharing one
   continuity proof) to attest a whole signal set per refresh cycle.
4. **Somnia source-chain support**: if/when Somnia gains a chainKey, the same pipeline attests
   DreamDEX settlement transactions directly — the module is parameterized by `chainKey`, so this
   is a configuration change, not a rewrite. Until then the split (Sepolia-attested signals +
   Somnia order books) is documented rather than blurred.
5. **Mainnet path**: the identical code targets CC3 mainnet (EVM chain id `10431`, explorer
   https://creditcoin.blockscout.com/) with Ethereum mainnet as source chain (chainKey 1 there);
   only RPC and chainKey configuration change, and ATC covers paid cross-chain actions while
   reads stay free.

---

## 9. Evidence: what was verified live on 2026-08-31

All of the following were executed against the live network during development
(read-only, no key, no funds). Full log kept internally (not distributed).

| # | Check | Result |
|---|---|---|
| 1 | `eth_chainId` on `https://rpc.cc3-testnet.creditcoin.network` | `0x18e8f` = **102031** (Creditcoin CC3 testnet) |
| 2 | `get_supported_chains()` on ChainInfo precompile `0x0FD3` | exactly two chains: chainKey **1** → chainId **11155111** (Sepolia), chainKey **3** → chainId **1** (Ethereum mainnet) |
| 3 | `get_latest_attestation_height_and_hash(1)` on `0x0FD3` | Sepolia height **11,606,090** — attestation actively advancing |
| 4 | Prover API `/api/v1/attested-height/1` | **11,606,080** |
| 5 | Prover API `/api/v1/proof-by-tx/1/0xbc1aef…f0e1` | full proof returned: Sepolia block **8,812,893**, `txIndex` **185**, Merkle proof + continuity proof |
| 6 | **`verify(...)` on Block Prover Precompile `0x0FD2` via `eth_call`** | **`true`** — the transaction is genuinely included in an attested Sepolia block |
| 7 | Decode `txBytes` with EvmV1Decoder `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` | type-2 transaction, **receipt status 1**, 1 log = standard `Transfer` event (topic `0xddf252ad…`) |
| 8 | `eth_getCode` on tutorial token `0x914Cf96BF28b7b4921db27b264ecEd71aC91134E` | bytecode present (contract deployed); CC3 testnet latest block **5,406,417** at the time |

Transaction used as the verified reference:
`0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1` (Sepolia).

---

## 10. Reference links

**Attestcoin / Creditcoin**
- Protocol overview: https://docs.attestcoin.org/attestcoin-protocol.md
- Architecture: https://docs.attestcoin.org/attestcoin-protocol/architecture.md
- Readability (attestation + transaction proving): https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability.md
- Writability: https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability.md
- Attestcoin Smart Contracts (ASCs): https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts.md
- SDK: https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk.md
- Source-chain smart contracts: https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts.md
- Offchain readability workers: https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers.md
- Design patterns (readability): https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability.md
- Gas costs: https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs.md
- Chains & environments: https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-chains-environments.md
- Testnet quickstart: https://docs.attestcoin.org/attestcoin-protocol/environments/testnet.md
- Guided tutorials: https://docs.attestcoin.org/attestcoin-protocol/guided-tutorials.md
- Creditcoin testnet environment: https://docs.creditcoin.org/environments/testnet.md
- Creditcoin testnet faucet: https://docs.creditcoin.org/wallets/using-testnet-faucet.md
- Attestcoin site (ATC, "reading other chains stays free"): https://attestcoin.org/

**Repos & packages**
- Example ASCs + tutorials: https://github.com/gluwa/attestcoin-protocol-examples
- Creditcoin implementation: https://github.com/gluwa/creditcoin
- SDK source: https://github.com/gluwa/cc-next-query-builder
- SDK npm (`@gluwa/usc-sdk` v0.18.0): https://www.npmjs.com/package/@gluwa/usc-sdk
- Contracts npm (`@gluwa/usc-contracts` v0.2.0): https://www.npmjs.com/package/@gluwa/usc-contracts

---

*Live checks dated 2026-08-31.*
