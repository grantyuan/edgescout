// ---------------------------------------------------------------------------
// EdgeScout — on-chain ASC state (READ-ONLY).
//
// src/lib/attest.ts proves a Sepolia transaction with a free eth_call and leaves
// no trace. EdgeScoutSignalStore — EdgeScout's own ASC (Attestcoin Smart
// Contract), source in contracts/src/EdgeScoutSignalStore.sol — is the other
// half: a worker submits the same proof to the contract, the contract re-verifies
// it through the Block Prover precompile (0x0FD2) *inside* the transaction, and
// then stores the decoded fact permanently.
//
// This module reads that stored state back. Like attest.ts it is strictly
// key-less and write-less: three eth_calls (getCode / signalCount /
// latestSignal), no wallet, no gas. The single write path lives outside the app
// in scripts/attest-on-asc.mjs, so the dashboard can never spend funds.
//
// Until the ASC is deployed (which needs tCTC from the Creditcoin Discord
// faucet), EDGE_SCOUT_ASC_ADDRESS is empty and this module reports
// `deployed: false` with a note instead of failing — the panel degrades, the
// dashboard does not.
//
// The chain transport is injectable (`reader`), so the unit tests in asc.test.ts
// run fully offline; the default transport lazy-imports ethers only when a real
// call happens (same pattern as attest.ts).
// ---------------------------------------------------------------------------

// --- configuration -----------------------------------------------------------

/** Creditcoin CC3 testnet wiring for the ASC read path. */
export const ASC = {
  /** Creditcoin CC3 testnet JSON-RPC (EVM chain id 102031). */
  rpcUrl:
    process.env.CC3_TESTNET_RPC?.trim() ||
    "https://rpc.cc3-testnet.creditcoin.network",
  /** EVM chain id of Creditcoin CC3 testnet. */
  chainId: 102031,
  /**
   * Deployed EdgeScoutSignalStore address. Empty until the ASC is deployed —
   * that is the expected state while testnet funds are pending, not an error.
   */
  address: process.env.EDGE_SCOUT_ASC_ADDRESS?.trim() || "",
  /**
   * EvmV1Decoder library address, when the ASC links against a deployed one.
   * With @gluwa/usc-contracts@0.2.0 the decoder is an internal-only library and
   * solc inlines it, so this stays empty and `null` is reported.
   */
  evmV1DecoderLib: process.env.EVMV1_DECODER_LIB_ADDRESS?.trim() || "",
  /** Block Prover precompile the ASC verifies against, for display. */
  blockProverPrecompile:
    process.env.BLOCK_PROVER_PRECOMPILE?.trim() ||
    "0x0000000000000000000000000000000000000FD2",
  /** Blockscout base URL, used to build the evidence links. */
  explorerUrl: (
    process.env.CC3_EXPLORER_URL?.trim() ||
    "https://creditcoin-testnet.blockscout.com"
  ).replace(/\/$/, ""),
} as const;

/** Shown when the address is unset — the honest "not deployed yet" state. */
const NOT_DEPLOYED_NOTE =
  "ASC not deployed yet: set EDGE_SCOUT_ASC_ADDRESS once EdgeScoutSignalStore " +
  "is deployed to Creditcoin CC3 testnet (deployment awaits testnet funds).";

/** Minimal ABI — only the read functions this module calls. */
export const ASC_READ_ABI = [
  "function signalCount() view returns (uint256)",
  "function latestSignal() view returns ((uint64,uint64,uint32,uint32,uint48,uint8,bytes32,bytes32))",
] as const;

// --- types -------------------------------------------------------------------

/**
 * One verified source-chain fact, as stored by the ASC.
 *
 * Field order in the contract's `StoredFact` struct is chosen for storage
 * packing; this is the same data in a JSON-friendly shape.
 */
export interface AscSignal {
  /** Attestcoin source-chain key (1 = Ethereum Sepolia). */
  chainKey: number;
  /** Source-chain block that includes the proven transaction. */
  blockNumber: number;
  /** Transaction index inside that block. */
  txIndex: number;
  txHash: string;
  /** Source-chain receipt status; always 1 (the ASC rejects failed receipts). */
  receiptStatus: number;
  /** Number of logs in the attested receipt. */
  logCount: number;
  /** Topic 0 of the receipt's first log, or the zero hash when there is none. */
  firstLogTopic: string;
  /** Creditcoin block timestamp at which the fact was recorded (ISO 8601). */
  storedAt: string;
}

/** Structured result of one ASC state read (JSON-safe throughout). */
export interface AscState {
  /** The read ran without a transport error. */
  ok: boolean;
  /** A contract with bytecode is configured and reachable. */
  deployed: boolean;
  ascAddress: string | null;
  evmV1DecoderLib: string | null;
  /** Number of facts stored, null when not deployed. */
  signalCount: number | null;
  latestSignal: AscSignal | null;
  /** Block Prover precompile the ASC verifies against. */
  precompile: string;
  rpcUrl: string;
  /** Blockscout link to the ASC, null when not deployed. */
  explorerUrl: string | null;
  fetchedAt: string;
  /** Human-readable explanation when `deployed` is false. */
  note?: string;
  error?: string;
}

/**
 * The raw `latestSignal()` tuple in contract field order:
 * (chainKey, headerNumber, txIndex, logCount, storedAt, receiptStatus, txHash,
 * firstLogTopic). ethers returns a Result, which is array-indexable.
 */
export type RawSignalTuple = ArrayLike<unknown>;

/** On-chain read surface (eth_call only). Tests inject a stub. */
export interface AscReader {
  /** eth_getCode — "0x" means nothing is deployed at that address. */
  getCode(address: string): Promise<string>;
  /** eth_call signalCount(). */
  signalCount(address: string): Promise<bigint | number>;
  /** eth_call latestSignal(); only called when signalCount > 0 (it reverts on empty). */
  latestSignal(address: string): Promise<RawSignalTuple>;
}

/** Injectable transports + call options. */
export interface AscOptions {
  /** Override the configured ASC address (mainly for tests). */
  address?: string | null;
  /** On-chain read transport (default: ethers over the CC3 RPC). */
  reader?: AscReader;
  /** Clock injection point for deterministic timestamps in tests. */
  now?: () => number;
}

// --- pure helpers ------------------------------------------------------------

/**
 * Validate a 20-byte EVM address. Returns null for anything that is not a
 * 0x-prefixed 40-hex-digit string, so a typo in .env never reaches the RPC.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed;
}

function toNumber(value: unknown, field: string): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (value == null || !Number.isFinite(n)) {
    throw new Error(`asc: malformed signal field ${field}`);
  }
  return n;
}

function toHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`asc: malformed signal field ${field}`);
  }
  return value.toLowerCase();
}

/**
 * Convert the packed `StoredFact` tuple into the JSON shape the UI consumes.
 * Throws on a malformed tuple so a contract/ABI drift fails loudly here rather
 * than rendering nonsense in the panel.
 */
export function decodeSignalTuple(raw: RawSignalTuple): AscSignal {
  if (raw == null || typeof raw !== "object" || raw.length < 8) {
    throw new Error("asc: malformed latestSignal tuple");
  }
  const storedAtSeconds = toNumber(raw[4], "storedAt");
  return {
    chainKey: toNumber(raw[0], "chainKey"),
    blockNumber: toNumber(raw[1], "headerNumber"),
    txIndex: toNumber(raw[2], "txIndex"),
    logCount: toNumber(raw[3], "logCount"),
    storedAt: new Date(storedAtSeconds * 1000).toISOString(),
    receiptStatus: toNumber(raw[5], "receiptStatus"),
    txHash: toHex(raw[6], "txHash"),
    firstLogTopic: toHex(raw[7], "firstLogTopic"),
  };
}

// --- transport ---------------------------------------------------------------

let defaultReader: Promise<AscReader> | null = null;

/**
 * Default on-chain transport: an ethers JsonRpcProvider pointed at CC3. Every
 * call is eth_call / eth_getCode — no signer, no gas, no funds.
 *
 * ethers is imported lazily so the unit tests (which always inject a stub
 * reader) never load it.
 */
export function getAscReader(): Promise<AscReader> {
  if (!defaultReader) {
    defaultReader = (async (): Promise<AscReader> => {
      const ethers = await import("ethers");
      const provider = new ethers.JsonRpcProvider(ASC.rpcUrl, ASC.chainId, {
        staticNetwork: true,
      });
      const contractAt = (address: string) =>
        new ethers.Contract(address, [...ASC_READ_ABI], provider);
      return {
        getCode: (address) => provider.getCode(address),
        signalCount: (address) => contractAt(address).signalCount!(),
        latestSignal: (address) => contractAt(address).latestSignal!(),
      };
    })();
  }
  return defaultReader;
}

/** Drop the cached reader (tests / long-lived dev servers). */
export function resetAscCache(): void {
  defaultReader = null;
}

// --- orchestration -----------------------------------------------------------

function baseState(fetchedAt: string): AscState {
  return {
    ok: true,
    deployed: false,
    ascAddress: null,
    evmV1DecoderLib: normalizeAddress(ASC.evmV1DecoderLib),
    signalCount: null,
    latestSignal: null,
    precompile: ASC.blockProverPrecompile,
    rpcUrl: ASC.rpcUrl,
    explorerUrl: null,
    fetchedAt,
  };
}

/**
 * Read the ASC's public state over eth_call.
 *
 * Never throws: a missing address reports `deployed: false` with a note, and a
 * transport failure reports `ok: false` with `error`, so a flaky testnet
 * degrades this one panel row instead of the dashboard.
 */
export async function getAscState(options: AscOptions = {}): Promise<AscState> {
  const now = options.now ?? Date.now;
  const fetchedAt = new Date(now()).toISOString();
  const state = baseState(fetchedAt);

  const configured = options.address ?? ASC.address;
  if (!configured) {
    return { ...state, note: NOT_DEPLOYED_NOTE };
  }

  const address = normalizeAddress(configured);
  if (address == null) {
    return {
      ...state,
      ok: false,
      error: `asc: invalid ASC address "${configured}" (expected 0x + 40 hex digits)`,
    };
  }
  state.ascAddress = address;
  state.explorerUrl = `${ASC.explorerUrl}/address/${address}`;

  try {
    const reader = options.reader ?? (await getAscReader());

    // 1. Is anything actually deployed there? An address in .env that points at
    //    an empty account is a configuration mistake, not a chain failure.
    const code = await reader.getCode(address);
    if (code == null || code === "0x") {
      return {
        ...state,
        note:
          `no contract bytecode at ${address} on Creditcoin CC3 testnet ` +
          "(chainId 102031) — check EDGE_SCOUT_ASC_ADDRESS",
      };
    }

    // 2. How many facts has the ASC verified and stored?
    const count = toNumber(await reader.signalCount(address), "signalCount");

    // 3. The newest one. latestSignal() reverts on an empty ledger, so it is
    //    only called when there is something to read.
    const latestSignal =
      count > 0 ? decodeSignalTuple(await reader.latestSignal(address)) : null;

    return { ...state, deployed: true, signalCount: count, latestSignal };
  } catch (e) {
    return {
      ...state,
      ok: false,
      error: `asc: state read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
