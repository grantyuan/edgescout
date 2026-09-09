// ---------------------------------------------------------------------------
// EdgeScout — Attestcoin Protocol integration (READ-ONLY)
//
// Attestcoin (formerly "USC", Universal Smart Contracts) is Creditcoin's
// cross-chain attestation layer: a decentralized attestor set agrees on
// source-chain (Ethereum / Sepolia) block digests and stores them on
// Creditcoin, so any Creditcoin contract — or, as here, any off-chain caller —
// can prove that a given source-chain transaction really was included in an
// attested block.
//
// This module is the read side of that pipeline and is deliberately
// key-less and write-less: no wallet, no signer, no funds, no chain writes.
//   1. supported source chains  — eth_call on the ChainInfo precompile (0x0FD3)
//   2. attested height          — GET {prover}/api/v1/attested-height/{chainKey}
//   3. transaction proof        — GET {prover}/api/v1/proof-by-tx/{chainKey}/{txHash}
//      → { chainKey, headerNumber, txIndex, txBytes,
//          merkleProof { root, siblings[] },
//          continuityProof { lowerEndpointDigest, roots[] } }
//   4. cryptographic verify     — eth_call (staticCall, zero gas, zero cost) on
//      the Block Prover precompile (0x0FD2) via the official SDK's
//      `blockProver.PrecompileBlockProver.verifySingle(...)`.
//
// Both network edges are injectable (`fetchImpl` + `verifier`), so the unit
// tests in attest.test.ts run fully offline and deterministically; the default
// transports lazy-import ethers + @gluwa/usc-sdk only when a real call happens.
//
// Env handling mirrors src/lib/config.ts (trimmed process.env with literal
// defaults, see .env.example). Everything here is public testnet data.
// ---------------------------------------------------------------------------

import type { proofProvider } from "@gluwa/usc-sdk";

// --- configuration -----------------------------------------------------------

/**
 * Attestcoin / Creditcoin CC3 testnet wiring. Defaults are the live public
 * testnet endpoints; every value can be overridden through the environment.
 */
export const ATTEST = {
  /** Creditcoin CC3 testnet JSON-RPC (EVM chain id 102031). */
  rpcUrl:
    process.env.CC3_TESTNET_RPC?.trim() ||
    "https://rpc.cc3-testnet.creditcoin.network",
  /** EVM chain id of Creditcoin CC3 testnet — the chain the proof is verified ON. */
  chainId: 102031,
  /** Hosted proof-builder service (free, no key). Trailing slash stripped. */
  proverUrl: (
    process.env.ATTEST_PROVER_URL?.trim() ||
    "https://prover.cc3-testnet.creditcoin.network"
  ).replace(/\/$/, ""),
  /** Source chain to read FROM: 1 = Ethereum Sepolia on CC3 testnet (3 = mainnet). */
  chainKey: Number(process.env.ATTEST_CHAIN_KEY || 1),
  /** Block Prover precompile — verify(...) returns bool, called via eth_call. */
  blockProverPrecompile:
    process.env.BLOCK_PROVER_PRECOMPILE?.trim() ||
    "0x0000000000000000000000000000000000000FD2",
  /** ChainInfo precompile — supported chains / attestation heights. */
  chainInfoPrecompile:
    process.env.CHAIN_INFO_PRECOMPILE?.trim() ||
    "0x0000000000000000000000000000000000000FD3",
  /**
   * EvmV1Decoder library deployed on CC3 testnet. Not needed for the read-only
   * verification path; recorded here because an ASC that decodes the attested
   * transaction bytes must link against it.
   */
  evmV1DecoderLib:
    process.env.EVTV1_DECODEER_LIB?.trim() ||
    "0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f",
  /**
   * Default attested transaction: the official tutorial "burn" tx on Sepolia
   * (block 8,812,893, txIndex 185), known to verify true against 0x0FD2.
   */
  defaultTxHash:
    process.env.ATTEST_DEFAULT_TX_HASH?.trim() ||
    "0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1",
  /** HTTP timeout for the prover calls (ms). */
  timeoutMs: Number(process.env.ATTEST_TIMEOUT_MS || 20_000),
} as const;

/** Friendly names per source chain id (the precompile returns hex-encoded bytes). */
const SOURCE_CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum Mainnet",
  11155111: "Ethereum Sepolia",
};

// --- types -------------------------------------------------------------------

/** One Merkle path element as served by the proof builder. */
export interface MerkleSibling {
  hash: string;
  isLeft: boolean;
}

/** Transaction-inclusion Merkle proof for one source-chain block. */
export interface MerkleProof {
  root: string;
  siblings: MerkleSibling[];
}

/** Continuity proof linking the block back to an attested endpoint. */
export interface ContinuityProof {
  lowerEndpointDigest: string;
  roots: string[];
}

/** Proof payload returned by GET /api/v1/proof-by-tx/{chainKey}/{txHash}. */
export interface AttestationProof {
  chainKey: number;
  headerNumber: number;
  txIndex: number;
  txHash: string;
  /** ABI-encoded source-chain transaction + receipt (hex). */
  txBytes: string;
  merkleProof: MerkleProof;
  continuityProof: ContinuityProof;
  /** True when the proof builder served this proof from its cache. */
  cached: boolean;
  /** ISO timestamp reported by the proof builder, null when absent. */
  generatedAt: string | null;
}

/**
 * Compile-time guard: our parsed proof must stay structurally acceptable to the
 * installed SDK's `PrecompileBlockProver.verifySingle(...)`. If @gluwa/usc-sdk
 * ever changes the proof shape, this type resolves to `never` and the build
 * fails here instead of at runtime against the live precompile.
 */
export type SdkProofCompatible =
  Omit<AttestationProof, "cached" | "generatedAt"> extends Omit<
    proofProvider.ContinuityResponse,
    "cached" | "generatedAt"
  >
    ? true
    : never;

/** Value form of the guard above (see SdkProofCompatible). */
export const SDK_PROOF_COMPATIBLE: SdkProofCompatible = true;

/** Raw chain descriptor as returned by the ChainInfo precompile. */
export interface RawChainInfo {
  chainKey: number | bigint;
  chainId: number | bigint;
  /** Hex-encoded ASCII bytes on-chain, e.g. "0x5365706f6c696120657468657265756d". */
  chainName: string;
  chainEncoding?: number | bigint;
}

/** Source chain in UI-ready form. */
export interface SourceChain {
  chainKey: number;
  chainId: number;
  name: string;
}

/** Structured result of one attestation check (JSON-safe throughout). */
export interface AttestationResult {
  /** The pipeline ran end to end (proof fetched and verification answered). */
  ok: boolean;
  /** The precompile cryptographically confirmed inclusion in an attested block. */
  verified: boolean;
  sourceChain: SourceChain | null;
  /** Source-chain block height holding the transaction. */
  blockNumber: number | null;
  txHash: string;
  txIndex: number | null;
  merkleRoot: string | null;
  /** Number of block roots in the continuity proof. */
  continuityBlocks: number | null;
  /** Highest source-chain height the prover has attestations for. */
  attestedHeight: number | null;
  /** attestedHeight - blockNumber, i.e. attestation depth of the proven block. */
  attestationLagBlocks: number | null;
  /** Block Prover precompile the verification eth_call went to. */
  precompile: string;
  /** Creditcoin CC3 RPC used for the verification eth_call. */
  rpcUrl: string;
  fetchedAt: string;
  error?: string;
}

/** Minimal fetch surface used here — the test suite injects a stub. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * On-chain read surface (eth_call only). The default implementation wraps the
 * official SDK precompile clients; tests inject a stub.
 */
export interface ChainVerifier {
  /** ChainInfo precompile (0x0FD3): source chains attested by Creditcoin. */
  getSupportedChains(): Promise<RawChainInfo[]>;
  /** Block Prover precompile (0x0FD2): verify(...) via staticCall — free. */
  verifyProof(proof: AttestationProof): Promise<boolean>;
}

/** Injectable transports + call options. */
export interface AttestationOptions {
  /** Source-chain transaction to attest; defaults to ATTEST.defaultTxHash. */
  txHash?: string | null;
  /** Source chain key; defaults to ATTEST.chainKey (1 = Sepolia). */
  chainKey?: number;
  /** HTTP transport for the prover API (default: global fetch). */
  fetchImpl?: FetchLike;
  /** On-chain read transport (default: the SDK precompile clients). */
  verifier?: ChainVerifier;
  /** Clock injection point for deterministic timestamps in tests. */
  now?: () => number;
}

// --- pure helpers ------------------------------------------------------------

/**
 * Validate and normalize a 32-byte transaction hash. Returns null for anything
 * that is not a 0x-prefixed 64-hex-digit string, so a bad `?txHash=` never
 * reaches the network.
 */
export function normalizeTxHash(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Decode the precompile's hex-encoded chain name into ASCII. The ChainInfo
 * precompile returns bytes (e.g. "0x5365706f6c696120657468657265756d" =
 * "Sepolia ethereum"), not a human string as the research sketch assumed.
 * Non-hex input is returned unchanged.
 */
export function decodeChainName(raw: string): string {
  if (typeof raw !== "string") return "";
  if (!/^0x([0-9a-fA-F]{2})*$/.test(raw)) return raw.trim();
  let out = "";
  for (let i = 2; i < raw.length; i += 2) {
    const code = Number.parseInt(raw.slice(i, i + 2), 16);
    // Keep printable ASCII only; padding/NUL bytes are dropped.
    if (code >= 0x20 && code <= 0x7e) out += String.fromCharCode(code);
  }
  return out.trim();
}

/** Normalize a precompile chain entry into the UI-ready SourceChain shape. */
export function describeSourceChain(chain: RawChainInfo): SourceChain {
  const chainKey = Number(chain.chainKey);
  const chainId = Number(chain.chainId);
  const decoded = decodeChainName(chain.chainName);
  return {
    chainKey,
    chainId,
    name: SOURCE_CHAIN_NAMES[chainId] ?? (decoded || `chain-${chainKey}`),
  };
}

/** Parse the /api/v1/attested-height/{chainKey} body; throws when malformed. */
export function parseAttestedHeight(raw: unknown): number {
  const height = (raw as { attestedHeight?: unknown })?.attestedHeight;
  const n = Number(height);
  if (height == null || !Number.isFinite(n)) {
    throw new Error("attest: malformed attested-height response");
  }
  return n;
}

function requireHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length < 3) {
    throw new Error(`attest: malformed proof field ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) {
    throw new Error(`attest: malformed proof field ${field}`);
  }
  return n;
}

/**
 * Validate the proof-builder payload into an AttestationProof. Every field the
 * precompile needs is checked here so a truncated/garbage response fails loudly
 * with a readable message instead of reverting inside the eth_call.
 */
export function parseProof(raw: unknown): AttestationProof {
  if (raw == null || typeof raw !== "object") {
    throw new Error("attest: proof response is not an object");
  }
  const r = raw as Record<string, unknown>;
  const merkle = r.merkleProof as Record<string, unknown> | undefined;
  const continuity = r.continuityProof as Record<string, unknown> | undefined;
  if (merkle == null || typeof merkle !== "object") {
    throw new Error("attest: malformed proof field merkleProof");
  }
  if (continuity == null || typeof continuity !== "object") {
    throw new Error("attest: malformed proof field continuityProof");
  }
  const siblingsRaw = merkle.siblings;
  if (!Array.isArray(siblingsRaw)) {
    throw new Error("attest: malformed proof field merkleProof.siblings");
  }
  const rootsRaw = continuity.roots;
  if (!Array.isArray(rootsRaw)) {
    throw new Error("attest: malformed proof field continuityProof.roots");
  }
  const siblings: MerkleSibling[] = siblingsRaw.map((s, i) => {
    const entry = s as Record<string, unknown>;
    return {
      hash: requireHex(entry?.hash, `merkleProof.siblings[${i}].hash`),
      isLeft: Boolean(entry?.isLeft),
    };
  });
  const roots = rootsRaw.map((root, i) =>
    requireHex(root, `continuityProof.roots[${i}]`),
  );
  const generatedAt = r.generatedAt;
  return {
    chainKey: requireNumber(r.chainKey, "chainKey"),
    headerNumber: requireNumber(r.headerNumber, "headerNumber"),
    txIndex: requireNumber(r.txIndex, "txIndex"),
    txHash: requireHex(r.txHash, "txHash"),
    txBytes: requireHex(r.txBytes, "txBytes"),
    merkleProof: {
      root: requireHex(merkle.root, "merkleProof.root"),
      siblings,
    },
    continuityProof: {
      lowerEndpointDigest: requireHex(
        continuity.lowerEndpointDigest,
        "continuityProof.lowerEndpointDigest",
      ),
      roots,
    },
    cached: Boolean(r.cached),
    generatedAt: typeof generatedAt === "string" ? generatedAt : null,
  };
}

// --- transports --------------------------------------------------------------

function resolveFetch(options: AttestationOptions): FetchLike {
  return options.fetchImpl ?? ((url, init) => fetch(url, init));
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  label: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(ATTEST.timeoutMs) });
  } catch (e) {
    throw new Error(
      `attest: ${label} request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`attest: ${label} HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(
      `attest: ${label} response unparseable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Highest source-chain block the proof builder holds attestations for.
 * GET {prover}/api/v1/attested-height/{chainKey}
 */
export async function fetchAttestedHeight(
  chainKey: number = ATTEST.chainKey,
  options: AttestationOptions = {},
): Promise<number> {
  const url = `${ATTEST.proverUrl}/api/v1/attested-height/${chainKey}`;
  return parseAttestedHeight(
    await getJson(resolveFetch(options), url, "attested-height"),
  );
}

/**
 * Fetch the Merkle + continuity proof for one source-chain transaction.
 * GET {prover}/api/v1/proof-by-tx/{chainKey}/{txHash}
 */
export async function fetchProof(
  chainKey: number,
  txHash: string,
  options: AttestationOptions = {},
): Promise<AttestationProof> {
  const url = `${ATTEST.proverUrl}/api/v1/proof-by-tx/${chainKey}/${txHash}`;
  return parseProof(await getJson(resolveFetch(options), url, "proof-by-tx"));
}

let defaultVerifier: Promise<ChainVerifier> | null = null;

/**
 * Default on-chain transport: the official SDK's precompile clients over an
 * ethers JsonRpcProvider pointed at CC3. Both calls are eth_call only
 * (`verifySingle` uses staticCall internally) — no signer, no gas, no funds.
 *
 * ethers + @gluwa/usc-sdk are imported lazily so the unit tests (which always
 * inject a stub verifier) never load them.
 */
export function getPrecompileVerifier(): Promise<ChainVerifier> {
  if (!defaultVerifier) {
    defaultVerifier = (async (): Promise<ChainVerifier> => {
      const [ethers, sdkModule] = await Promise.all([
        import("ethers"),
        import("@gluwa/usc-sdk"),
      ]);
      // The SDK ships CommonJS; under Node ESM the namespace hides behind
      // `default`, while bundlers expose the named namespaces directly.
      const sdk =
        (sdkModule as unknown as { default?: typeof sdkModule }).default ??
        sdkModule;
      const provider = new ethers.JsonRpcProvider(ATTEST.rpcUrl, ATTEST.chainId, {
        staticNetwork: true,
      });
      const chainInfoProvider = new sdk.chainInfo.PrecompileChainInfoProvider(
        provider,
        ATTEST.chainInfoPrecompile,
      );
      const blockProver = new sdk.blockProver.PrecompileBlockProver(
        provider,
        ATTEST.blockProverPrecompile,
      );
      return {
        getSupportedChains: () => chainInfoProvider.getSupportedChains(),
        verifyProof: (proof) =>
          blockProver.verifySingle(
            proof.chainKey,
            proof.headerNumber,
            proof.txBytes,
            proof.merkleProof,
            proof.continuityProof,
          ),
      };
    })();
  }
  return defaultVerifier;
}

// --- supported chains (static cache) -----------------------------------------

let supportedChainsCache: SourceChain[] | null = null;

/**
 * Supported source chains, cached process-wide: the set changes only when
 * Creditcoin onboards a new chain, so one eth_call per process is plenty.
 */
export async function getSupportedChains(
  options: AttestationOptions = {},
): Promise<SourceChain[]> {
  if (supportedChainsCache) return supportedChainsCache;
  const verifier = options.verifier ?? (await getPrecompileVerifier());
  const chains = await verifier.getSupportedChains();
  const described = (Array.isArray(chains) ? chains : []).map(describeSourceChain);
  supportedChainsCache = described;
  return described;
}

/** Drop the cached supported-chain list (tests / long-lived dev servers). */
export function resetAttestCache(): void {
  supportedChainsCache = null;
  defaultVerifier = null;
}

// --- orchestration -----------------------------------------------------------

/** Verify one proof on-chain (eth_call, free). */
export async function verifyProof(
  proof: AttestationProof,
  options: AttestationOptions = {},
): Promise<boolean> {
  const verifier = options.verifier ?? (await getPrecompileVerifier());
  return verifier.verifyProof(proof);
}

function failure(
  txHash: string,
  fetchedAt: string,
  error: string,
  sourceChain: SourceChain | null = null,
  attestedHeight: number | null = null,
): AttestationResult {
  return {
    ok: false,
    verified: false,
    sourceChain,
    blockNumber: null,
    txHash,
    txIndex: null,
    merkleRoot: null,
    continuityBlocks: null,
    attestedHeight,
    attestationLagBlocks: null,
    precompile: ATTEST.blockProverPrecompile,
    rpcUrl: ATTEST.rpcUrl,
    fetchedAt,
    error,
  };
}

/**
 * Full read-only attestation check:
 *   supported-chain lookup → attested height → proof fetch → on-chain verify.
 *
 * Never throws: transport problems come back as `ok: false` with `error`, so a
 * flaky testnet degrades the panel instead of the dashboard. `verified` is the
 * precompile's own answer and is only meaningful when `ok` is true.
 */
export async function getAttestation(
  options: AttestationOptions = {},
): Promise<AttestationResult> {
  const now = options.now ?? Date.now;
  const fetchedAt = new Date(now()).toISOString();
  const chainKey = options.chainKey ?? ATTEST.chainKey;
  const txHash = normalizeTxHash(options.txHash ?? ATTEST.defaultTxHash);
  if (txHash == null) {
    return failure(
      String(options.txHash ?? ""),
      fetchedAt,
      "attest: invalid transaction hash (expected 0x + 64 hex digits)",
    );
  }

  // 1. Is this source chain attested by Creditcoin at all? (cached eth_call)
  let sourceChain: SourceChain | null = null;
  try {
    const chains = await getSupportedChains(options);
    sourceChain = chains.find((c) => c.chainKey === chainKey) ?? null;
    if (sourceChain == null) {
      return failure(
        txHash,
        fetchedAt,
        `attest: chainKey ${chainKey} is not a supported source chain`,
      );
    }
  } catch (e) {
    return failure(
      txHash,
      fetchedAt,
      `attest: supported-chain lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 2. Attestation frontier. Informational only — a hiccup here must not sink
  //    an otherwise valid proof, so it degrades to null.
  let attestedHeight: number | null = null;
  try {
    attestedHeight = await fetchAttestedHeight(chainKey, options);
  } catch {
    attestedHeight = null;
  }

  // 3. Proof from the hosted proof builder (free HTTP).
  let proof: AttestationProof;
  try {
    proof = await fetchProof(chainKey, txHash, options);
  } catch (e) {
    return failure(
      txHash,
      fetchedAt,
      e instanceof Error ? e.message : String(e),
      sourceChain,
      attestedHeight,
    );
  }

  // 4. Cryptographic verification on Creditcoin (eth_call → bool).
  let verified: boolean;
  try {
    verified = await verifyProof(proof, options);
  } catch (e) {
    return failure(
      txHash,
      fetchedAt,
      `attest: on-chain verification failed: ${e instanceof Error ? e.message : String(e)}`,
      sourceChain,
      attestedHeight,
    );
  }

  return {
    ok: true,
    verified,
    sourceChain,
    blockNumber: proof.headerNumber,
    txHash: proof.txHash,
    txIndex: proof.txIndex,
    merkleRoot: proof.merkleProof.root,
    continuityBlocks: proof.continuityProof.roots.length,
    attestedHeight,
    attestationLagBlocks:
      attestedHeight == null ? null : attestedHeight - proof.headerNumber,
    precompile: ATTEST.blockProverPrecompile,
    rpcUrl: ATTEST.rpcUrl,
    fetchedAt,
  };
}
