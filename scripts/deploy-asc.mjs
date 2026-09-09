#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EdgeScout — deploy the ASC (EdgeScoutSignalStore) to Creditcoin CC3 testnet.
//
//   node scripts/deploy-asc.mjs [--dry-run]
//
// Plain ethers v6, no framework. The script is IDEMPOTENT: it records what it
// deployed in .attestcoin/deployed.json and, on a second run, re-checks each
// recorded address with eth_getCode and skips anything already on chain.
//
// It reads the throwaway testnet keypair from .attestcoin/key.json. That
// directory is gitignored and must never be committed — it is a testnet-only
// key holding testnet-only funds.
//
// Prerequisites:
//   1. `cd contracts && forge build`     (produces contracts/out/**)
//   2. the deployer address holds tCTC   (Creditcoin Discord faucet, see below)
//
// On a zero balance the script fails loudly and prints the exact faucet steps
// instead of sending a transaction that is guaranteed to fail.
//
// A note on the EvmV1Decoder library
// ----------------------------------
// The official tutorials deploy EvmV1Decoder as a separate library and link the
// ASC against it. In @gluwa/usc-contracts@0.2.0 the decoder
// (contracts/write-ability/common/EvmV1Decoder.sol) exposes `internal` functions
// only, so solc INLINES it and the compiled ASC contains no link references at
// all. Rather than hard-coding either behaviour, this script reads the link
// references out of the Foundry artifact: if the compiler asks for a library it
// is deployed and linked, otherwise the step is reported as "inlined" and
// skipped. Both paths write the same deployed.json shape.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther } from "ethers";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG = {
  /** Creditcoin CC3 testnet JSON-RPC. */
  rpcUrl: process.env.CC3_TESTNET_RPC?.trim() || "https://rpc.cc3-testnet.creditcoin.network",
  /** EVM chain id of CC3 testnet — a mismatch aborts the run. */
  chainId: 102031,
  explorer: "https://creditcoin-testnet.blockscout.com",
  keyPath: join(REPO_ROOT, ".attestcoin", "key.json"),
  deployedPath: join(REPO_ROOT, ".attestcoin", "deployed.json"),
  artifactsDir: join(REPO_ROOT, "contracts", "out"),
  /** Deployment order: libraries first, then the ASC that may link against them. */
  ascName: "EdgeScoutSignalStore",
  ascArtifact: ["EdgeScoutSignalStore.sol", "EdgeScoutSignalStore.json"],
};

const DRY_RUN = process.argv.includes("--dry-run");

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

/** Load a Foundry artifact (abi + bytecode + linkReferences). */
function loadArtifact([dir, file]) {
  const path = join(CONFIG.artifactsDir, dir, file);
  if (!existsSync(path)) {
    fail(
      `missing Foundry artifact ${path}`,
      "  Build the contracts first:\n    cd contracts && forge build",
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadDeployer() {
  if (!existsSync(CONFIG.keyPath)) {
    fail(
      `missing ${CONFIG.keyPath}`,
      [
        "  Create a throwaway TESTNET key (never a key that holds real funds):",
        "    mkdir -p .attestcoin && chmod 700 .attestcoin",
        '    node -e \'const {Wallet}=require("ethers");const w=Wallet.createRandom();' +
          'require("fs").writeFileSync(".attestcoin/key.json",JSON.stringify(' +
          '{purpose:"creditcoin cc3 testnet only",address:w.address,privateKey:w.privateKey},null,2))\'',
        "    chmod 600 .attestcoin/key.json",
      ].join("\n"),
    );
  }
  const key = JSON.parse(readFileSync(CONFIG.keyPath, "utf8"));
  if (typeof key.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key.privateKey)) {
    fail(`${CONFIG.keyPath} has no valid "privateKey" field`);
  }
  return key;
}

function readDeployed() {
  if (!existsSync(CONFIG.deployedPath)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG.deployedPath, "utf8"));
  } catch {
    return {};
  }
}

function writeDeployed(record) {
  mkdirSync(dirname(CONFIG.deployedPath), { recursive: true });
  writeFileSync(CONFIG.deployedPath, `${JSON.stringify(record, null, 2)}\n`);
}

function faucetInstructions(address) {
  return [
    "  The deployer has 0 tCTC, so no transaction can be sent.",
    "",
    "  Fund it from the Creditcoin testnet faucet (manual, ~100 tCTC per 24h):",
    "    1. Join the Creditcoin Discord:  https://discord.gg/creditcoin",
    "    2. Open the  #token-faucet  channel",
    `    3. Run:  /faucet address:${address}`,
    "    4. Wait for the bot to confirm, then re-run this script:",
    "         node scripts/deploy-asc.mjs",
    "",
    `  Balance check: ${CONFIG.explorer}/address/${address}`,
  ].join("\n");
}

/** Substitute deployed library addresses into a bytecode's link placeholders. */
function linkBytecode(bytecode, linkReferences, resolvedLibraries) {
  let linked = bytecode;
  for (const [file, contracts] of Object.entries(linkReferences ?? {})) {
    for (const [name, slots] of Object.entries(contracts)) {
      const address = resolvedLibraries[name];
      if (!address) fail(`no deployed address for linked library ${file}:${name}`);
      const clean = address.toLowerCase().replace(/^0x/, "");
      for (const { start, length } of slots) {
        // Offsets are byte offsets into the bytecode; the hex string skips "0x".
        const from = 2 + start * 2;
        const to = from + length * 2;
        linked = linked.slice(0, from) + clean + linked.slice(to);
      }
    }
  }
  return linked;
}

/** True when `address` already has contract bytecode on chain. */
async function isDeployed(provider, address) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const code = await provider.getCode(address);
  return code != null && code !== "0x";
}

async function main() {
  console.log("EdgeScout ASC deployment — Creditcoin CC3 testnet");
  console.log("=".repeat(64));

  const artifact = loadArtifact(CONFIG.ascArtifact);
  const linkReferences = artifact.bytecode?.linkReferences ?? {};
  const requiredLibraries = Object.values(linkReferences).flatMap((c) => Object.keys(c));

  const key = loadDeployer();
  const provider = new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
  const wallet = new Wallet(key.privateKey, provider);

  console.log(`  RPC        ${CONFIG.rpcUrl}`);
  console.log(`  Deployer   ${wallet.address}`);

  const network = await provider.getNetwork().catch((e) => {
    fail(`cannot reach ${CONFIG.rpcUrl}: ${e.message}`);
  });
  if (Number(network.chainId) !== CONFIG.chainId) {
    fail(`wrong network: RPC reports chainId ${network.chainId}, expected ${CONFIG.chainId}`);
  }
  console.log(`  Network    chainId ${network.chainId} ✓`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`  Balance    ${formatEther(balance)} tCTC`);
  if (balance === 0n) {
    fail("deployer is not funded — testnet funds are required to deploy", faucetInstructions(wallet.address));
  }

  const previous = readDeployed();
  const record = {
    network: "creditcoin-cc3-testnet",
    chainId: CONFIG.chainId,
    rpcUrl: CONFIG.rpcUrl,
    deployer: wallet.address,
    // Null means "not a separate contract": in @gluwa/usc-contracts@0.2.0 the
    // decoder is an internal-only library and is inlined into the ASC bytecode.
    evmV1DecoderLib: previous.evmV1DecoderLib ?? null,
    decoderLinkage: requiredLibraries.length === 0 ? "inlined" : "linked",
    edgeScoutSignalStore: previous.edgeScoutSignalStore ?? null,
    txHashes: { ...(previous.txHashes ?? {}) },
    deployedAt: previous.deployedAt ?? null,
  };

  // --- 1. libraries ---------------------------------------------------------
  const libraryAddresses = {};
  if (requiredLibraries.length === 0) {
    console.log("\n  [1/2] EvmV1Decoder library");
    console.log("        inlined by solc (internal-only library in @gluwa/usc-contracts@0.2.0)");
    console.log("        → no library deployment, no linking required");
  } else {
    for (const name of requiredLibraries) {
      console.log(`\n  [1/2] library ${name}`);
      if (await isDeployed(provider, previous[`lib:${name}`] ?? previous.evmV1DecoderLib)) {
        const existing = previous[`lib:${name}`] ?? previous.evmV1DecoderLib;
        libraryAddresses[name] = existing;
        console.log(`        already deployed at ${existing} — skipped`);
        continue;
      }
      const libArtifact = loadArtifact([`${name}.sol`, `${name}.json`]);
      if (DRY_RUN) {
        console.log("        [dry-run] would deploy");
        continue;
      }
      const factory = new ContractFactory(libArtifact.abi, libArtifact.bytecode.object, wallet);
      const lib = await factory.deploy();
      const tx = lib.deploymentTransaction();
      await lib.waitForDeployment();
      libraryAddresses[name] = await lib.getAddress();
      record.txHashes[name] = tx?.hash ?? null;
      if (name === "EvmV1Decoder") record.evmV1DecoderLib = libraryAddresses[name];
      record[`lib:${name}`] = libraryAddresses[name];
      console.log(`        deployed at ${libraryAddresses[name]}  (tx ${tx?.hash})`);
      writeDeployed(record);
    }
  }

  // --- 2. the ASC -----------------------------------------------------------
  console.log(`\n  [2/2] ${CONFIG.ascName} (the ASC)`);
  if (await isDeployed(provider, previous.edgeScoutSignalStore)) {
    record.edgeScoutSignalStore = previous.edgeScoutSignalStore;
    console.log(`        already deployed at ${record.edgeScoutSignalStore} — skipped`);
  } else if (DRY_RUN) {
    console.log("        [dry-run] would deploy");
  } else {
    const linked = linkBytecode(artifact.bytecode.object, linkReferences, libraryAddresses);
    const factory = new ContractFactory(artifact.abi, linked, wallet);
    const asc = await factory.deploy();
    const tx = asc.deploymentTransaction();
    await asc.waitForDeployment();
    record.edgeScoutSignalStore = await asc.getAddress();
    record.txHashes[CONFIG.ascName] = tx?.hash ?? null;
    record.deployedAt = new Date().toISOString();
    console.log(`        deployed at ${record.edgeScoutSignalStore}  (tx ${tx?.hash})`);
  }

  if (!DRY_RUN) writeDeployed(record);

  console.log(`\n${"=".repeat(64)}`);
  console.log(JSON.stringify(record, null, 2));
  if (record.edgeScoutSignalStore) {
    console.log(`\n  Explorer   ${CONFIG.explorer}/address/${record.edgeScoutSignalStore}`);
    console.log("\n  Next steps:");
    console.log("    1. Put the address in .env so the dashboard can read it:");
    console.log(`         EDGE_SCOUT_ASC_ADDRESS=${record.edgeScoutSignalStore}`);
    console.log("    2. Record the first verified fact on chain:");
    console.log("         node scripts/attest-on-asc.mjs");
  }
  if (!DRY_RUN) console.log(`\n  Written to ${CONFIG.deployedPath} (gitignored)`);
}

main().catch((e) => {
  console.error(`\n✗ deployment failed: ${e?.message ?? e}`);
  process.exit(1);
});
