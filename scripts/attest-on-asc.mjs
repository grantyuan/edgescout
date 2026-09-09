#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EdgeScout — record one cryptographically verified source-chain fact on the ASC.
//
//   node scripts/attest-on-asc.mjs [txHash] [--chain-key 1] [--dry-run]
//
// This is the DEMO of EdgeScout's on-chain Attestcoin integration, and the only
// step in the whole project that spends tCTC:
//
//   1. GET {prover}/api/v1/proof-by-tx/{chainKey}/{txHash}   (free HTTP)
//   2. eth_call  EdgeScoutSignalStore.isProcessed(queryId)   (free, skips a
//      pointless paid transaction when the fact is already recorded)
//   3. send      EdgeScoutSignalStore.attestTx(...)          ← costs tCTC
//      The ASC calls the Block Prover precompile 0x0FD2 inside that call, so the
//      proof is verified by Creditcoin's attestor set, not by this script.
//   4. eth_call  signalCount() / signals(latest)             (free) — read the
//      stored fact back out of chain state and print it as JSON.
//
// The printed Blockscout transaction link is the hackathon's proof artifact:
// anyone can open it and see the ASC's SignalStored event next to the
// protocol's own TransactionVerified event from the precompile.
//
// The source transaction defaults to the official Attestcoin tutorial "burn"
// transaction on Sepolia, which is known to be attested and to have receipt
// status 1. Pass any other attested Sepolia tx hash as the first argument.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Contract, JsonRpcProvider, Wallet, formatEther, keccak256 } from "ethers";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG = {
  rpcUrl: process.env.CC3_TESTNET_RPC?.trim() || "https://rpc.cc3-testnet.creditcoin.network",
  chainId: 102031,
  proverUrl: (
    process.env.ATTEST_PROVER_URL?.trim() || "https://prover.cc3-testnet.creditcoin.network"
  ).replace(/\/$/, ""),
  chainKey: Number(process.env.ATTEST_CHAIN_KEY || 1),
  defaultTxHash:
    process.env.ATTEST_DEFAULT_TX_HASH?.trim() ||
    "0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1",
  explorer: "https://creditcoin-testnet.blockscout.com",
  keyPath: join(REPO_ROOT, ".attestcoin", "key.json"),
  deployedPath: join(REPO_ROOT, ".attestcoin", "deployed.json"),
  timeoutMs: Number(process.env.ATTEST_TIMEOUT_MS || 20_000),
};

/** Minimal ABI — only what this script calls. */
const ASC_ABI = [
  "function attestTx(uint256 chainKey, uint256 headerNumber, uint256 txIndex, bytes32 txHash, bytes txBytes, (bytes32,(bytes32,bool)[]) merkleProof, (bytes32,bytes32[]) continuityProof) returns (bytes32)",
  "function computeQueryId(uint256 chainKey, uint256 headerNumber, uint256 txIndex, bytes32 txHash) view returns (bytes32)",
  "function signalCount() view returns (uint256)",
  "function isProcessed(bytes32 queryId) view returns (bool)",
  "function precompileAddress() view returns (address)",
  "function latestSignal() view returns ((uint64,uint64,uint32,uint32,uint48,uint8,bytes32,bytes32))",
  "event SignalStored(bytes32 indexed queryId, uint64 indexed chainKey, bytes32 indexed txHash, uint256 index, uint64 headerNumber, uint32 txIndex, uint8 receiptStatus, uint32 logCount, bytes32 firstLogTopic, uint48 storedAt)",
];

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { txHash: null, chainKey: CONFIG.chainKey, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--chain-key") args.chainKey = Number(argv[(i += 1)]);
    else if (!arg.startsWith("--") && args.txHash == null) args.txHash = arg;
  }
  return args;
}

/** Same validation as src/lib/attest.ts: 0x + 64 hex digits, lowercased. */
function normalizeTxHash(raw) {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.trim())) return null;
  return raw.trim().toLowerCase();
}

function resolveAscAddress() {
  const fromEnv = process.env.EDGE_SCOUT_ASC_ADDRESS?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(CONFIG.deployedPath)) {
    const record = JSON.parse(readFileSync(CONFIG.deployedPath, "utf8"));
    if (record.edgeScoutSignalStore) return record.edgeScoutSignalStore;
  }
  return fail(
    "the ASC is not deployed yet",
    [
      `  No EDGE_SCOUT_ASC_ADDRESS in the environment and no address in ${CONFIG.deployedPath}.`,
      "",
      "  Deploy it first (needs tCTC from the Creditcoin Discord faucet):",
      "    cd contracts && forge build && cd ..",
      "    node scripts/deploy-asc.mjs",
    ].join("\n"),
  );
}

async function fetchProof(chainKey, txHash) {
  const url = `${CONFIG.proverUrl}/api/v1/proof-by-tx/${chainKey}/${txHash}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(CONFIG.timeoutMs) }).catch((e) => {
    fail(`proof request failed: ${e.message}`, `  ${url}`);
  });
  if (!res.ok) {
    fail(
      `proof builder answered HTTP ${res.status}`,
      `  ${url}\n  The transaction may not be attested yet, or may be too old to prove.`,
    );
  }
  return res.json();
}

function main() {
  return run().catch((e) => {
    fail(e?.shortMessage ?? e?.message ?? String(e));
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const txHash = normalizeTxHash(args.txHash ?? CONFIG.defaultTxHash);
  if (txHash == null) fail(`invalid transaction hash: ${args.txHash} (expected 0x + 64 hex digits)`);

  console.log("EdgeScout ASC demo — attest a Sepolia transaction on Creditcoin CC3");
  console.log("=".repeat(70));

  const ascAddress = resolveAscAddress();
  const provider = new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });

  console.log(`  ASC        ${ascAddress}`);
  console.log(`  Source     chainKey ${args.chainKey} tx ${txHash}`);

  // --- 1. proof from the hosted prover (free) -------------------------------
  const proof = await fetchProof(args.chainKey, txHash);
  console.log(
    `  Proof      block ${proof.headerNumber}, txIndex ${proof.txIndex}, ` +
      `${proof.merkleProof?.siblings?.length ?? 0} merkle siblings, ` +
      `${proof.continuityProof?.roots?.length ?? 0} continuity roots`,
  );

  // The ASC hashes exactly this tuple; computing it here lets us check on-chain
  // state before paying for a transaction that would revert as a replay.
  const queryId = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "uint256", "bytes32"],
      [proof.chainKey, proof.headerNumber, proof.txIndex, proof.txHash],
    ),
  );
  console.log(`  Query id   ${queryId}`);

  const readOnly = new Contract(ascAddress, ASC_ABI, provider);
  if ((await provider.getCode(ascAddress)) === "0x") {
    fail(`no contract bytecode at ${ascAddress} on chainId ${CONFIG.chainId}`);
  }

  const onChainQueryId = await readOnly.computeQueryId(
    proof.chainKey,
    proof.headerNumber,
    proof.txIndex,
    proof.txHash,
  );
  if (onChainQueryId.toLowerCase() !== queryId.toLowerCase()) {
    fail(`query id mismatch: contract says ${onChainQueryId}, script computed ${queryId}`);
  }

  if (await readOnly.isProcessed(queryId)) {
    console.log("\n  Already recorded on chain — skipping the paid transaction.");
    await printState(readOnly, ascAddress, null);
    return;
  }

  if (args.dryRun) {
    console.log("\n  [dry-run] proof fetched and query id verified; no transaction sent.");
    return;
  }

  // --- 2. the one paid step -------------------------------------------------
  if (!existsSync(CONFIG.keyPath)) fail(`missing ${CONFIG.keyPath} (throwaway testnet key)`);
  const key = JSON.parse(readFileSync(CONFIG.keyPath, "utf8"));
  const wallet = new Wallet(key.privateKey, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log(`  Sender     ${wallet.address}  (${formatEther(balance)} tCTC)`);
  if (balance === 0n) {
    fail(
      "sender has 0 tCTC — attestTx is a state-changing call and needs gas",
      [
        "  Fund it from the Creditcoin testnet faucet (~100 tCTC per 24h):",
        "    1. Join  https://discord.gg/creditcoin",
        "    2. Open the  #token-faucet  channel",
        `    3. Run:  /faucet address:${wallet.address}`,
      ].join("\n"),
    );
  }

  const asc = new Contract(ascAddress, ASC_ABI, wallet);
  const merkleProof = [
    proof.merkleProof.root,
    proof.merkleProof.siblings.map((s) => [s.hash, Boolean(s.isLeft)]),
  ];
  const continuityProof = [proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots];

  console.log("\n  Sending attestTx… (the ASC calls precompile 0x0FD2 inside this transaction)");
  const tx = await asc.attestTx(
    proof.chainKey,
    proof.headerNumber,
    proof.txIndex,
    proof.txHash,
    proof.txBytes,
    merkleProof,
    continuityProof,
  );
  console.log(`  tx hash    ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) fail(`attestTx reverted (tx ${tx.hash})`);
  console.log(`  mined      block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);

  await printState(readOnly, ascAddress, tx.hash);
}

/** Read the ASC's state back with eth_call and print the demo's JSON result. */
async function printState(readOnly, ascAddress, txHash) {
  const [count, precompile] = await Promise.all([
    readOnly.signalCount(),
    readOnly.precompileAddress(),
  ]);
  const latest = count > 0n ? await readOnly.latestSignal() : null;

  const result = {
    ok: true,
    ascAddress,
    precompile,
    signalCount: Number(count),
    latestSignal:
      latest == null
        ? null
        : {
            chainKey: Number(latest[0]),
            blockNumber: Number(latest[1]),
            txIndex: Number(latest[2]),
            logCount: Number(latest[3]),
            storedAt: new Date(Number(latest[4]) * 1000).toISOString(),
            receiptStatus: Number(latest[5]),
            txHash: latest[6],
            firstLogTopic: latest[7],
          },
    attestTxHash: txHash,
    explorerTx: txHash ? `${CONFIG.explorer}/tx/${txHash}` : null,
    explorerAsc: `${CONFIG.explorer}/address/${ascAddress}`,
  };

  console.log(`\n${"=".repeat(70)}`);
  console.log(JSON.stringify(result, null, 2));
  if (txHash) {
    console.log(`\n  Proof artifact (open this in a browser):\n    ${result.explorerTx}`);
  }
}

await main();
