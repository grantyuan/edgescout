// ---------------------------------------------------------------------------
// EdgeScout — ASC state-read tests (node:test, no framework).
//
// Deterministic and fully OFFLINE: the on-chain (eth_call) transport is
// injected as a stub, so no Creditcoin RPC request is ever made here. The
// contract itself is tested separately and thoroughly by the Foundry suite in
// contracts/test/ (29 tests), and the live path is exercised through
// GET /api/asc once the ASC is deployed.
// Run: npm test
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import {
  ASC,
  decodeSignalTuple,
  getAscState,
  normalizeAddress,
  type AscReader,
} from "./asc.ts";

// --- fixtures ----------------------------------------------------------------

const ADDRESS = "0x894fC0E88B8DeF2b72BA295cB12aAb55f2Ef868b";
const TX_HASH =
  "0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1";
/** ERC-20 Transfer(address,address,uint256) — topic 0 of the tutorial tx. */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * A `latestSignal()` tuple in contract field order:
 * (chainKey, headerNumber, txIndex, logCount, storedAt, receiptStatus, txHash,
 * firstLogTopic). Values match what the real ASC stored for the tutorial
 * transaction during end-to-end validation.
 */
const SIGNAL_TUPLE: unknown[] = [
  BigInt(1),
  BigInt(8_812_893),
  BigInt(185),
  BigInt(1),
  BigInt(1_788_196_237),
  BigInt(1),
  TX_HASH,
  TRANSFER_TOPIC,
];

interface Stubs extends AscReader {
  calls: string[];
}

/** Build an injectable reader; `code: "0x"` simulates "nothing deployed here". */
function makeReader(opts: {
  code?: string;
  count?: bigint;
  tuple?: unknown[];
  throwOn?: "getCode" | "signalCount" | "latestSignal";
} = {}): Stubs {
  const calls: string[] = [];
  const boom = (where: string) => {
    if (opts.throwOn === where) throw new Error(`stub ${where} failure`);
  };
  return {
    calls,
    async getCode(address) {
      calls.push(`getCode:${address}`);
      boom("getCode");
      return opts.code ?? "0x6080604052";
    },
    async signalCount(address) {
      calls.push(`signalCount:${address}`);
      boom("signalCount");
      return opts.count ?? BigInt(1);
    },
    async latestSignal(address) {
      calls.push(`latestSignal:${address}`);
      boom("latestSignal");
      return (opts.tuple ?? SIGNAL_TUPLE) as ArrayLike<unknown>;
    },
  };
}

const NOW = () => Date.parse("2026-09-01T00:00:00.000Z");

// --- pure helpers ------------------------------------------------------------

test("normalizeAddress accepts a valid address and rejects malformed input", () => {
  assert.equal(normalizeAddress(ADDRESS), ADDRESS);
  assert.equal(normalizeAddress(`  ${ADDRESS}  `), ADDRESS);
  assert.equal(normalizeAddress(""), null);
  assert.equal(normalizeAddress("0x1234"), null);
  assert.equal(normalizeAddress(`${ADDRESS}ff`), null);
  assert.equal(normalizeAddress("not-an-address"), null);
  assert.equal(normalizeAddress(null), null);
});

test("decodeSignalTuple maps the packed StoredFact tuple into JSON shape", () => {
  const signal = decodeSignalTuple(SIGNAL_TUPLE as ArrayLike<unknown>);
  assert.deepEqual(signal, {
    chainKey: 1,
    blockNumber: 8_812_893,
    txIndex: 185,
    logCount: 1,
    storedAt: "2026-08-31T17:10:37.000Z",
    receiptStatus: 1,
    txHash: TX_HASH,
    firstLogTopic: TRANSFER_TOPIC,
  });
});

test("decodeSignalTuple rejects a malformed tuple instead of rendering nonsense", () => {
  assert.throws(
    () => decodeSignalTuple([BigInt(1), BigInt(2)] as ArrayLike<unknown>),
    /malformed/,
  );
  const badHash = [...SIGNAL_TUPLE];
  badHash[6] = "not-hex";
  assert.throws(() => decodeSignalTuple(badHash as ArrayLike<unknown>), /txHash/);
});

// --- state read --------------------------------------------------------------

test("getAscState reports deployed:false with a note when no address is configured", async () => {
  const reader = makeReader();
  const state = await getAscState({ address: "", reader, now: NOW });
  assert.equal(state.ok, true);
  assert.equal(state.deployed, false);
  assert.equal(state.ascAddress, null);
  assert.equal(state.signalCount, null);
  assert.equal(state.latestSignal, null);
  assert.match(state.note ?? "", /not deployed yet/);
  assert.equal(state.precompile, ASC.blockProverPrecompile);
  assert.equal(state.fetchedAt, "2026-09-01T00:00:00.000Z");
  // No address means no RPC traffic at all.
  assert.deepEqual(reader.calls, []);
});

test("getAscState reads count and latest signal from a deployed ASC", async () => {
  const reader = makeReader({ count: BigInt(3) });
  const state = await getAscState({ address: ADDRESS, reader, now: NOW });
  assert.equal(state.ok, true);
  assert.equal(state.deployed, true);
  assert.equal(state.ascAddress, ADDRESS);
  assert.equal(state.signalCount, 3);
  assert.equal(state.latestSignal?.txHash, TX_HASH);
  assert.equal(state.latestSignal?.blockNumber, 8_812_893);
  assert.equal(state.latestSignal?.receiptStatus, 1);
  assert.equal(state.latestSignal?.firstLogTopic, TRANSFER_TOPIC);
  assert.equal(state.explorerUrl, `${ASC.explorerUrl}/address/${ADDRESS}`);
  assert.deepEqual(reader.calls, [
    `getCode:${ADDRESS}`,
    `signalCount:${ADDRESS}`,
    `latestSignal:${ADDRESS}`,
  ]);
});

test("getAscState skips latestSignal when the ledger is empty (it reverts on empty)", async () => {
  const reader = makeReader({ count: BigInt(0) });
  const state = await getAscState({ address: ADDRESS, reader, now: NOW });
  assert.equal(state.deployed, true);
  assert.equal(state.signalCount, 0);
  assert.equal(state.latestSignal, null);
  assert.ok(!reader.calls.some((c) => c.startsWith("latestSignal")));
});

test("getAscState reports deployed:false when the address holds no bytecode", async () => {
  const reader = makeReader({ code: "0x" });
  const state = await getAscState({ address: ADDRESS, reader, now: NOW });
  assert.equal(state.ok, true);
  assert.equal(state.deployed, false);
  assert.equal(state.ascAddress, ADDRESS);
  assert.match(state.note ?? "", /no contract bytecode/);
  assert.ok(!reader.calls.some((c) => c.startsWith("signalCount")));
});

test("getAscState rejects a malformed configured address without calling the RPC", async () => {
  const reader = makeReader();
  const state = await getAscState({ address: "0xdeadbeef", reader, now: NOW });
  assert.equal(state.ok, false);
  assert.equal(state.deployed, false);
  assert.match(state.error ?? "", /invalid ASC address/);
  assert.deepEqual(reader.calls, []);
});

test("getAscState degrades to ok:false when the CC3 transport fails", async () => {
  const state = await getAscState({
    address: ADDRESS,
    reader: makeReader({ throwOn: "signalCount" }),
    now: NOW,
  });
  assert.equal(state.ok, false);
  assert.equal(state.deployed, false);
  assert.match(state.error ?? "", /state read failed: stub signalCount failure/);
  assert.equal(state.signalCount, null);
});

test("ASC config points at Creditcoin CC3 testnet and the block prover precompile", () => {
  assert.equal(ASC.chainId, 102031);
  assert.match(ASC.rpcUrl, /^https?:\/\//);
  assert.equal(
    ASC.blockProverPrecompile.toLowerCase(),
    "0x0000000000000000000000000000000000000fd2",
  );
});
