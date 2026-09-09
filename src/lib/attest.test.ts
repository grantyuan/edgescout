// ---------------------------------------------------------------------------
// EdgeScout — Attestcoin integration tests (node:test, no framework).
//
// Every case is deterministic and fully OFFLINE: the prover HTTP transport and
// the on-chain (eth_call) transport are injected as stubs, so no Creditcoin RPC
// or proof-builder request is ever made here. The live path is exercised
// separately through GET /api/attest against CC3 testnet.
// Run: npm test
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTEST,
  decodeChainName,
  describeSourceChain,
  fetchAttestedHeight,
  fetchProof,
  getAttestation,
  getSupportedChains,
  normalizeTxHash,
  parseAttestedHeight,
  parseProof,
  resetAttestCache,
  type AttestationProof,
  type ChainVerifier,
  type FetchLike,
  type RawChainInfo,
} from "./attest.ts";

// --- fixtures ----------------------------------------------------------------

const TX = ATTEST.defaultTxHash;
const OTHER_TX =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

/** The two source chains CC3 testnet actually attests (hex-encoded names). */
const SUPPORTED_CHAINS: RawChainInfo[] = [
  { chainKey: 3, chainId: 1, chainName: "0x457468657265756d", chainEncoding: 1 },
  {
    chainKey: 1,
    chainId: 11155111,
    chainName: "0x5365706f6c696120657468657265756d",
    chainEncoding: 1,
  },
];

/** Proof payload shaped exactly like the live proof builder's response. */
function proofBody(txHash = TX): Record<string, unknown> {
  return {
    chainKey: 1,
    headerNumber: 8812893,
    txIndex: 185,
    txHash,
    txBytes: "0x02f8b1830aa36c",
    merkleProof: {
      root: "0xe490667215c1e8d471599e3444379f72ac47adec298140e23eb02f134143dcd5",
      siblings: [
        { hash: "0xaa11", isLeft: true },
        { hash: "0xbb22", isLeft: false },
      ],
    },
    continuityProof: {
      lowerEndpointDigest: "0xcc33",
      roots: ["0xdd44", "0xee55", "0xff66"],
    },
    cached: true,
    generatedAt: "2026-08-31T14:36:49.692164156Z",
  };
}

interface Stubs {
  fetchImpl: FetchLike;
  verifier: ChainVerifier;
  urls: string[];
  chainCalls: () => number;
  verifyCalls: () => number;
}

/**
 * Build injectable transports. `routes` maps a URL substring to the Response
 * the stub should answer with; unmatched URLs answer 404.
 */
function makeStubs(opts: {
  verified?: boolean;
  verifyThrows?: string;
  chainsThrow?: string;
  heightStatus?: number;
  proofStatus?: number;
  proofBodyText?: string;
  chains?: RawChainInfo[];
} = {}): Stubs {
  const urls: string[] = [];
  let chainCalls = 0;
  let verifyCalls = 0;
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    if (url.includes("/attested-height/")) {
      if (opts.heightStatus && opts.heightStatus !== 200) {
        return new Response("upstream down", { status: opts.heightStatus });
      }
      return new Response(JSON.stringify({ attestedHeight: 11606240 }), {
        status: 200,
      });
    }
    if (url.includes("/proof-by-tx/")) {
      if (opts.proofStatus && opts.proofStatus !== 200) {
        return new Response("not found", { status: opts.proofStatus });
      }
      const hash = url.slice(url.lastIndexOf("/") + 1);
      return new Response(opts.proofBodyText ?? JSON.stringify(proofBody(hash)), {
        status: 200,
      });
    }
    return new Response("unexpected", { status: 404 });
  };
  const verifier: ChainVerifier = {
    async getSupportedChains() {
      chainCalls += 1;
      if (opts.chainsThrow) throw new Error(opts.chainsThrow);
      return opts.chains ?? SUPPORTED_CHAINS;
    },
    async verifyProof() {
      verifyCalls += 1;
      if (opts.verifyThrows) throw new Error(opts.verifyThrows);
      return opts.verified ?? true;
    },
  };
  return {
    fetchImpl,
    verifier,
    urls,
    chainCalls: () => chainCalls,
    verifyCalls: () => verifyCalls,
  };
}

const FIXED_NOW = () => Date.parse("2026-08-31T15:00:00.000Z");

// --- pure helpers -------------------------------------------------------------

test("normalizeTxHash: accepts 32-byte hashes, lowercases, rejects garbage", () => {
  assert.equal(normalizeTxHash(TX), TX);
  assert.equal(normalizeTxHash(`  ${TX.toUpperCase().replace("0X", "0x")}  `), TX);
  assert.equal(normalizeTxHash("0x1234"), null);
  assert.equal(normalizeTxHash("nope"), null);
  assert.equal(normalizeTxHash(null), null);
  assert.equal(normalizeTxHash(undefined), null);
  // 64 chars but not hex
  assert.equal(normalizeTxHash(`0x${"z".repeat(64)}`), null);
});

test("decodeChainName: precompile returns hex-encoded ASCII bytes", () => {
  assert.equal(decodeChainName("0x5365706f6c696120657468657265756d"), "Sepolia ethereum");
  assert.equal(decodeChainName("0x457468657265756d"), "Ethereum");
  // Non-hex input passes through untouched.
  assert.equal(decodeChainName("Somnia"), "Somnia");
  assert.equal(decodeChainName("0x"), "");
});

test("describeSourceChain: friendly names by chain id, fallback otherwise", () => {
  const sepolia = describeSourceChain(SUPPORTED_CHAINS[1]);
  assert.deepEqual(sepolia, { chainKey: 1, chainId: 11155111, name: "Ethereum Sepolia" });
  const mainnet = describeSourceChain(SUPPORTED_CHAINS[0]);
  assert.deepEqual(mainnet, { chainKey: 3, chainId: 1, name: "Ethereum Mainnet" });
  // Unknown chain id → decoded on-chain name; bigints (ethers) are coerced.
  const other = describeSourceChain({
    chainKey: BigInt(7),
    chainId: BigInt(999),
    chainName: "0x53746172",
  });
  assert.deepEqual(other, { chainKey: 7, chainId: 999, name: "Star" });
  // Unknown id with an empty name → synthetic label.
  assert.equal(describeSourceChain({ chainKey: 8, chainId: 42, chainName: "0x" }).name, "chain-8");
});

test("parseAttestedHeight: reads the attestedHeight field, rejects junk", () => {
  assert.equal(parseAttestedHeight({ attestedHeight: 11606240 }), 11606240);
  assert.equal(parseAttestedHeight({ attestedHeight: "11606240" }), 11606240);
  assert.throws(() => parseAttestedHeight({}), /malformed attested-height/);
  assert.throws(() => parseAttestedHeight(null), /malformed attested-height/);
  assert.throws(() => parseAttestedHeight({ attestedHeight: "abc" }), /malformed attested-height/);
});

test("parseProof: accepts the live proof shape", () => {
  const p: AttestationProof = parseProof(proofBody());
  assert.equal(p.chainKey, 1);
  assert.equal(p.headerNumber, 8812893);
  assert.equal(p.txIndex, 185);
  assert.equal(p.txHash, TX);
  assert.equal(p.merkleProof.siblings.length, 2);
  assert.equal(p.merkleProof.siblings[0].isLeft, true);
  assert.equal(p.continuityProof.roots.length, 3);
  assert.equal(p.cached, true);
  assert.equal(p.generatedAt, "2026-08-31T14:36:49.692164156Z");
});

test("parseProof: rejects malformed payloads field by field", () => {
  assert.throws(() => parseProof("not-json-object"), /not an object/);
  const noMerkle = proofBody();
  delete noMerkle.merkleProof;
  assert.throws(() => parseProof(noMerkle), /merkleProof/);
  const noRoots = proofBody();
  (noRoots.continuityProof as Record<string, unknown>).roots = "nope";
  assert.throws(() => parseProof(noRoots), /continuityProof\.roots/);
  const badSibling = proofBody();
  (badSibling.merkleProof as Record<string, unknown>).siblings = [{ hash: 42, isLeft: true }];
  assert.throws(() => parseProof(badSibling), /siblings\[0\]\.hash/);
  const badHeader = proofBody();
  badHeader.headerNumber = "not-a-number";
  assert.throws(() => parseProof(badHeader), /headerNumber/);
});

// --- transports ---------------------------------------------------------------

test("fetchAttestedHeight: hits the prover endpoint and returns the height", async () => {
  const stubs = makeStubs();
  const height = await fetchAttestedHeight(1, { fetchImpl: stubs.fetchImpl });
  assert.equal(height, 11606240);
  assert.equal(stubs.urls.length, 1);
  assert.equal(stubs.urls[0], `${ATTEST.proverUrl}/api/v1/attested-height/1`);
});

test("fetchProof: builds the documented proof-by-tx URL", async () => {
  const stubs = makeStubs();
  const proof = await fetchProof(1, TX, { fetchImpl: stubs.fetchImpl });
  assert.equal(stubs.urls[0], `${ATTEST.proverUrl}/api/v1/proof-by-tx/1/${TX}`);
  assert.equal(proof.headerNumber, 8812893);
});

// --- getAttestation orchestration ---------------------------------------------

test("getAttestation: success path — verified true against the precompile", async () => {
  resetAttestCache();
  const stubs = makeStubs({ verified: true });
  const r = await getAttestation({
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.sourceChain, {
    chainKey: 1,
    chainId: 11155111,
    name: "Ethereum Sepolia",
  });
  assert.equal(r.blockNumber, 8812893);
  assert.equal(r.txHash, TX);
  assert.equal(r.txIndex, 185);
  assert.equal(
    r.merkleRoot,
    "0xe490667215c1e8d471599e3444379f72ac47adec298140e23eb02f134143dcd5",
  );
  assert.equal(r.continuityBlocks, 3);
  assert.equal(r.attestedHeight, 11606240);
  assert.equal(r.attestationLagBlocks, 11606240 - 8812893);
  assert.equal(r.precompile, ATTEST.blockProverPrecompile);
  assert.equal(r.fetchedAt, "2026-08-31T15:00:00.000Z");
  assert.equal(stubs.verifyCalls(), 1);
  // The result must survive a JSON round-trip (it is served by /api/attest).
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("getAttestation: precompile answers false → ok true, verified false", async () => {
  resetAttestCache();
  const stubs = makeStubs({ verified: false });
  const r = await getAttestation({
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.equal(r.error, undefined);
  assert.equal(r.blockNumber, 8812893);
});

test("getAttestation: proof 404 → ok false with the HTTP status in the error", async () => {
  resetAttestCache();
  const stubs = makeStubs({ proofStatus: 404 });
  const r = await getAttestation({
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.verified, false);
  assert.match(r.error ?? "", /proof-by-tx HTTP 404/);
  // The source chain resolved before the failure is still reported.
  assert.equal(r.sourceChain?.name, "Ethereum Sepolia");
  assert.equal(r.blockNumber, null);
  assert.equal(r.merkleRoot, null);
  // Verification is never attempted without a proof.
  assert.equal(stubs.verifyCalls(), 0);
});

test("getAttestation: malformed proof JSON → ok false, no verification attempt", async () => {
  resetAttestCache();
  const stubs = makeStubs({ proofBodyText: "{ not json" });
  const r = await getAttestation({
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /proof-by-tx response unparseable/);
  assert.equal(stubs.verifyCalls(), 0);
});

test("getAttestation: structurally invalid proof → ok false with the field name", async () => {
  resetAttestCache();
  const broken = proofBody();
  delete broken.continuityProof;
  const stubs = makeStubs({ proofBodyText: JSON.stringify(broken) });
  const r = await getAttestation({
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /malformed proof field continuityProof/);
});

test("getAttestation: default vs custom txHash reaches the right endpoint", async () => {
  resetAttestCache();
  const a = makeStubs();
  const rDefault = await getAttestation({
    fetchImpl: a.fetchImpl,
    verifier: a.verifier,
    now: FIXED_NOW,
  });
  assert.equal(rDefault.txHash, ATTEST.defaultTxHash);
  assert.ok(a.urls.some((u) => u.endsWith(`/proof-by-tx/1/${ATTEST.defaultTxHash}`)));

  const b = makeStubs();
  const rCustom = await getAttestation({
    txHash: OTHER_TX.toUpperCase().replace("0X", "0x"),
    fetchImpl: b.fetchImpl,
    verifier: b.verifier,
    now: FIXED_NOW,
  });
  assert.equal(rCustom.ok, true);
  assert.equal(rCustom.txHash, OTHER_TX);
  assert.ok(b.urls.some((u) => u.endsWith(`/proof-by-tx/1/${OTHER_TX}`)));
});

test("getAttestation: invalid txHash short-circuits before any network call", async () => {
  resetAttestCache();
  const stubs = makeStubs();
  const r = await getAttestation({
    txHash: "0xdeadbeef",
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /invalid transaction hash/);
  assert.equal(stubs.urls.length, 0);
  assert.equal(stubs.chainCalls(), 0);
  assert.equal(stubs.verifyCalls(), 0);
});

test("getAttestation: chainKey override selects the mainnet source chain", async () => {
  resetAttestCache();
  const stubs = makeStubs();
  const r = await getAttestation({
    chainKey: 3,
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sourceChain, { chainKey: 3, chainId: 1, name: "Ethereum Mainnet" });
  assert.ok(stubs.urls.some((u) => u.endsWith("/attested-height/3")));
  assert.ok(stubs.urls.some((u) => u.includes("/proof-by-tx/3/")));
});

test("getAttestation: unsupported chainKey → ok false, nothing fetched", async () => {
  resetAttestCache();
  const stubs = makeStubs();
  const r = await getAttestation({
    chainKey: 99,
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /chainKey 99 is not a supported source chain/);
  assert.equal(stubs.urls.length, 0);
});

test("getAttestation: attested-height outage degrades to null, proof still verifies", async () => {
  resetAttestCache();
  const stubs = makeStubs({ heightStatus: 503 });
  const r = await getAttestation({
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.attestedHeight, null);
  assert.equal(r.attestationLagBlocks, null);
});

test("getAttestation: RPC failure on the chain lookup → ok false", async () => {
  resetAttestCache();
  const stubs = makeStubs({ chainsThrow: "connection refused" });
  const r = await getAttestation({
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /supported-chain lookup failed: connection refused/);
});

test("getAttestation: verification eth_call revert → ok false, verified false", async () => {
  resetAttestCache();
  const stubs = makeStubs({ verifyThrows: "execution reverted" });
  const r = await getAttestation({
    fetchImpl: stubs.fetchImpl,
    verifier: stubs.verifier,
    now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.verified, false);
  assert.match(r.error ?? "", /on-chain verification failed: execution reverted/);
});

// --- caching ------------------------------------------------------------------

test("getSupportedChains: the precompile call is cached process-wide", async () => {
  resetAttestCache();
  const stubs = makeStubs();
  const first = await getSupportedChains({ verifier: stubs.verifier });
  const second = await getSupportedChains({ verifier: stubs.verifier });
  assert.equal(stubs.chainCalls(), 1);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);

  // Two full attestations reuse the same cached chain list…
  await getAttestation({ fetchImpl: stubs.fetchImpl, verifier: stubs.verifier });
  await getAttestation({ fetchImpl: stubs.fetchImpl, verifier: stubs.verifier });
  assert.equal(stubs.chainCalls(), 1);
  assert.equal(stubs.verifyCalls(), 2);

  // …until the cache is explicitly reset.
  resetAttestCache();
  await getSupportedChains({ verifier: stubs.verifier });
  assert.equal(stubs.chainCalls(), 2);
});

test("getSupportedChains: a failed lookup is not cached", async () => {
  resetAttestCache();
  const failing = makeStubs({ chainsThrow: "rpc down" });
  await assert.rejects(
    () => getSupportedChains({ verifier: failing.verifier }),
    /rpc down/,
  );
  const healthy = makeStubs();
  const chains = await getSupportedChains({ verifier: healthy.verifier });
  assert.equal(chains.length, 2);
  assert.equal(healthy.chainCalls(), 1);
  resetAttestCache();
});
