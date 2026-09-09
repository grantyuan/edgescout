// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {INativeQueryVerifier} from
    "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {EdgeScoutSignalStore} from "../src/EdgeScoutSignalStore.sol";
import {
    AcceptingBlockProver,
    RejectingBlockProver,
    RevertingBlockProver,
    ReentrantBlockProver
} from "./BlockProverStub.sol";

/**
 * @title EdgeScoutSignalStore tests
 * @notice Fully offline: the Block Prover precompile at `0x0FD2` is replaced with a stub via
 *         `vm.etch`, so the real call path (same address, same calldata, same return decoding)
 *         runs without a live Creditcoin attestor set. Nothing here touches the network.
 */
contract EdgeScoutSignalStoreTest is Test {
    EdgeScoutSignalStore internal store;

    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    uint256 internal constant CHAIN_KEY = 1; // Ethereum Sepolia on CC3 testnet
    uint256 internal constant HEADER_NUMBER = 8_812_893;
    uint256 internal constant TX_INDEX = 185;
    bytes32 internal constant TX_HASH =
        0xbc1aefc42f7bc5897e7693e815831729dc401877df182b137ab3bf06edeaf0e1;
    /// @dev ERC-20 `Transfer(address,address,uint256)` — topic 0 of the tutorial transaction.
    bytes32 internal constant TRANSFER_TOPIC =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    /// @dev Mirror of the contract's event, so `vm.expectEmit` can match it.
    event SignalStored(
        bytes32 indexed queryId,
        uint64 indexed chainKey,
        bytes32 indexed txHash,
        uint256 index,
        uint64 headerNumber,
        uint32 txIndex,
        uint8 receiptStatus,
        uint32 logCount,
        bytes32 firstLogTopic,
        uint48 storedAt
    );

    function setUp() public {
        store = new EdgeScoutSignalStore();
        _useProver(address(new AcceptingBlockProver()));
        vm.warp(1_756_600_000); // deterministic `storedAt`
    }

    // --- helpers ---------------------------------------------------------------------------

    /// @dev Install a stub AT the real precompile address, exercising the production path.
    function _useProver(address stub) internal {
        vm.etch(PRECOMPILE, stub.code);
    }

    /**
     * @dev Build `txBytes` in the exact wire format the prover API serves and the official
     *      EvmV1Decoder expects: `abi.encode(uint8 txType, bytes[] chunks)` with
     *      `chunks[2] = abi.encode(status, gasUsed, logs, logsBloom)` for a type-2 transaction.
     */
    function _txBytes(uint8 receiptStatus, uint256 logCount, bytes32 firstTopic)
        internal
        pure
        returns (bytes memory)
    {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](logCount);
        for (uint256 i; i < logCount; ++i) {
            bytes32[] memory topics = new bytes32[](2);
            topics[0] = i == 0 ? firstTopic : bytes32(uint256(0xbeef));
            topics[1] = bytes32(i);
            logs[i] = EvmV1Decoder.LogEntryTuple({
                address_: address(0xA11CE),
                topics: topics,
                data: hex"1234"
            });
        }
        return _encodeTx(receiptStatus, logs);
    }

    /// @dev A receipt whose single log carries no topics at all (anonymous event).
    function _txBytesWithTopiclessLog(uint8 receiptStatus) internal pure returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({
            address_: address(0xA11CE),
            topics: new bytes32[](0),
            data: hex"1234"
        });
        return _encodeTx(receiptStatus, logs);
    }

    function _encodeTx(uint8 receiptStatus, EvmV1Decoder.LogEntryTuple[] memory logs)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = abi.encode(
            uint64(7), uint64(21_000), address(0xF00), false, address(0xBA5), uint256(0), bytes("")
        );
        chunks[1] = ""; // type-specific fields; untouched by decodeReceiptFields
        chunks[2] = abi.encode(receiptStatus, uint64(50_000), logs, bytes(hex"00"));
        return abi.encode(uint8(2), chunks);
    }

    function _merkleProof() internal pure returns (INativeQueryVerifier.MerkleProof memory p) {
        INativeQueryVerifier.MerkleProofEntry[] memory siblings =
            new INativeQueryVerifier.MerkleProofEntry[](2);
        siblings[0] = INativeQueryVerifier.MerkleProofEntry({hash: bytes32(uint256(0xaa11)), isLeft: true});
        siblings[1] = INativeQueryVerifier.MerkleProofEntry({hash: bytes32(uint256(0xbb22)), isLeft: false});
        p = INativeQueryVerifier.MerkleProof({root: bytes32(uint256(0xe490)), siblings: siblings});
    }

    function _continuityProof()
        internal
        pure
        returns (INativeQueryVerifier.ContinuityProof memory p)
    {
        bytes32[] memory roots = new bytes32[](3);
        roots[0] = bytes32(uint256(0xdd44));
        roots[1] = bytes32(uint256(0xee55));
        roots[2] = bytes32(uint256(0xff66));
        p = INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: bytes32(uint256(0xcc33)),
            roots: roots
        });
    }

    function _attest(uint256 headerNumber, uint256 txIndex, bytes32 txHash, bytes memory txBytes)
        internal
        returns (bytes32)
    {
        return store.attestTx(
            CHAIN_KEY, headerNumber, txIndex, txHash, txBytes, _merkleProof(), _continuityProof()
        );
    }

    function _attestDefault() internal returns (bytes32) {
        return _attest(HEADER_NUMBER, TX_INDEX, TX_HASH, _txBytes(1, 1, TRANSFER_TOPIC));
    }

    // --- configuration ---------------------------------------------------------------------

    function test_PrecompileAddressIsTheOfficialBlockProver() public view {
        assertEq(store.precompileAddress(), PRECOMPILE);
        assertEq(store.BLOCK_PROVER_PRECOMPILE(), PRECOMPILE);
    }

    function test_StartsEmptyWithFullCapacity() public view {
        assertEq(store.signalCount(), 0);
        assertEq(store.MAX_SIGNALS(), 1000);
        assertEq(store.remainingCapacity(), 1000);
    }

    // --- query id --------------------------------------------------------------------------

    function test_ComputeQueryIdIsKeccakOfAbiEncodedTuple() public view {
        assertEq(
            store.computeQueryId(CHAIN_KEY, HEADER_NUMBER, TX_INDEX, TX_HASH),
            keccak256(abi.encode(CHAIN_KEY, HEADER_NUMBER, TX_INDEX, TX_HASH))
        );
    }

    function testFuzz_ComputeQueryIdMatchesAbiEncode(
        uint256 chainKey,
        uint256 headerNumber,
        uint256 txIndex,
        bytes32 txHash
    ) public view {
        assertEq(
            store.computeQueryId(chainKey, headerNumber, txIndex, txHash),
            keccak256(abi.encode(chainKey, headerNumber, txIndex, txHash))
        );
    }

    function test_QueryIdIsUniquePerTupleField() public view {
        bytes32 base = store.computeQueryId(CHAIN_KEY, HEADER_NUMBER, TX_INDEX, TX_HASH);
        assertTrue(base != store.computeQueryId(3, HEADER_NUMBER, TX_INDEX, TX_HASH));
        assertTrue(base != store.computeQueryId(CHAIN_KEY, HEADER_NUMBER + 1, TX_INDEX, TX_HASH));
        assertTrue(base != store.computeQueryId(CHAIN_KEY, HEADER_NUMBER, TX_INDEX + 1, TX_HASH));
        assertTrue(base != store.computeQueryId(CHAIN_KEY, HEADER_NUMBER, TX_INDEX, bytes32(0)));
    }

    // --- happy path ------------------------------------------------------------------------

    function test_AttestStoresDecodedFact() public {
        bytes32 queryId = _attestDefault();

        assertEq(queryId, store.computeQueryId(CHAIN_KEY, HEADER_NUMBER, TX_INDEX, TX_HASH));
        assertEq(store.signalCount(), 1);
        assertEq(store.remainingCapacity(), 999);
        assertTrue(store.isProcessed(queryId));

        EdgeScoutSignalStore.StoredFact memory fact = store.latestSignal();
        assertEq(fact.chainKey, uint64(CHAIN_KEY));
        assertEq(fact.headerNumber, uint64(HEADER_NUMBER));
        assertEq(fact.txIndex, uint32(TX_INDEX));
        assertEq(fact.txHash, TX_HASH);
        assertEq(fact.receiptStatus, 1);
        assertEq(fact.logCount, 1);
        assertEq(fact.firstLogTopic, TRANSFER_TOPIC);
        assertEq(fact.storedAt, uint48(block.timestamp));
    }

    function test_ViewsAgreeAcrossArrayMappingAndGetter() public {
        bytes32 queryId = _attestDefault();

        // Array getter, mapping lookup and `latestSignal` must describe the same fact.
        (
            uint64 chainKey,
            uint64 headerNumber,
            uint32 txIndex,
            uint32 logCount,
            uint48 storedAt,
            uint8 receiptStatus,
            bytes32 txHash,
            bytes32 firstLogTopic
        ) = store.signals(0);

        EdgeScoutSignalStore.StoredFact memory byQuery = store.factOfQuery(queryId);
        EdgeScoutSignalStore.StoredFact memory latest = store.latestSignal();

        assertEq(chainKey, byQuery.chainKey);
        assertEq(headerNumber, byQuery.headerNumber);
        assertEq(txIndex, byQuery.txIndex);
        assertEq(logCount, byQuery.logCount);
        assertEq(storedAt, byQuery.storedAt);
        assertEq(receiptStatus, byQuery.receiptStatus);
        assertEq(txHash, byQuery.txHash);
        assertEq(firstLogTopic, byQuery.firstLogTopic);
        assertEq(latest.txHash, byQuery.txHash);
        assertEq(latest.storedAt, byQuery.storedAt);
    }

    function test_AttestEmitsSignalStored() public {
        bytes32 queryId = store.computeQueryId(CHAIN_KEY, HEADER_NUMBER, TX_INDEX, TX_HASH);

        vm.expectEmit(true, true, true, true, address(store));
        emit SignalStored(
            queryId,
            uint64(CHAIN_KEY),
            TX_HASH,
            0,
            uint64(HEADER_NUMBER),
            uint32(TX_INDEX),
            1,
            1,
            TRANSFER_TOPIC,
            uint48(block.timestamp)
        );

        _attestDefault();
    }

    function test_StoresManySignalsInOrder() public {
        for (uint256 i; i < 5; ++i) {
            _attest(HEADER_NUMBER + i, TX_INDEX, bytes32(i + 1), _txBytes(1, 1, TRANSFER_TOPIC));
        }
        assertEq(store.signalCount(), 5);
        for (uint256 i; i < 5; ++i) {
            (, uint64 headerNumber,,,,, bytes32 txHash,) = store.signals(i);
            assertEq(headerNumber, uint64(HEADER_NUMBER + i));
            assertEq(txHash, bytes32(i + 1));
        }
        assertEq(store.latestSignal().headerNumber, uint64(HEADER_NUMBER + 4));
    }

    function test_MultiLogReceiptRecordsCountAndFirstTopic() public {
        _attest(HEADER_NUMBER, TX_INDEX, TX_HASH, _txBytes(1, 4, TRANSFER_TOPIC));
        EdgeScoutSignalStore.StoredFact memory fact = store.latestSignal();
        assertEq(fact.logCount, 4);
        assertEq(fact.firstLogTopic, TRANSFER_TOPIC);
    }

    function test_ReceiptWithoutLogsStoresZeroTopic() public {
        _attest(HEADER_NUMBER, TX_INDEX, TX_HASH, _txBytes(1, 0, bytes32(0)));
        EdgeScoutSignalStore.StoredFact memory fact = store.latestSignal();
        assertEq(fact.logCount, 0);
        assertEq(fact.firstLogTopic, bytes32(0));
    }

    function test_TopiclessLogStoresZeroTopic() public {
        _attest(HEADER_NUMBER, TX_INDEX, TX_HASH, _txBytesWithTopiclessLog(1));
        EdgeScoutSignalStore.StoredFact memory fact = store.latestSignal();
        assertEq(fact.logCount, 1);
        assertEq(fact.firstLogTopic, bytes32(0));
    }

    // --- replay protection -------------------------------------------------------------------

    function test_ReplayOfSameQueryReverts() public {
        bytes32 queryId = _attestDefault();

        vm.expectRevert(
            abi.encodeWithSelector(EdgeScoutSignalStore.QueryAlreadyProcessed.selector, queryId)
        );
        _attestDefault();

        assertEq(store.signalCount(), 1); // nothing was appended by the failed replay
    }

    function test_DifferentTxIndexIsNotAReplay() public {
        _attestDefault();
        _attest(HEADER_NUMBER, TX_INDEX + 1, TX_HASH, _txBytes(1, 1, TRANSFER_TOPIC));
        assertEq(store.signalCount(), 2);
    }

    function test_UnknownQueryIsNotProcessedAndReturnsEmptyFact() public view {
        bytes32 unknown = store.computeQueryId(CHAIN_KEY, 1, 2, bytes32(uint256(3)));
        assertFalse(store.isProcessed(unknown));
        EdgeScoutSignalStore.StoredFact memory fact = store.factOfQuery(unknown);
        assertEq(fact.chainKey, 0);
        assertEq(fact.headerNumber, 0);
        assertEq(fact.txHash, bytes32(0));
        assertEq(fact.storedAt, 0);
    }

    // --- rejection paths ---------------------------------------------------------------------

    function test_RevertsWhenPrecompileReturnsFalse() public {
        _useProver(address(new RejectingBlockProver()));
        bytes32 queryId = store.computeQueryId(CHAIN_KEY, HEADER_NUMBER, TX_INDEX, TX_HASH);

        vm.expectRevert(abi.encodeWithSelector(EdgeScoutSignalStore.ProofRejected.selector, queryId));
        _attestDefault();

        assertEq(store.signalCount(), 0);
        assertFalse(store.isProcessed(queryId));
    }

    function test_RevertsWhenPrecompileReverts() public {
        _useProver(address(new RevertingBlockProver()));
        vm.expectRevert(RevertingBlockProver.InvalidProof.selector);
        _attestDefault();
        assertEq(store.signalCount(), 0);
    }

    function test_RevertsWhenSourceReceiptFailed() public {
        vm.expectRevert(
            abi.encodeWithSelector(EdgeScoutSignalStore.SourceTransactionFailed.selector, uint8(0))
        );
        _attest(HEADER_NUMBER, TX_INDEX, TX_HASH, _txBytes(0, 1, TRANSFER_TOPIC));
        assertEq(store.signalCount(), 0);
    }

    function test_RevertsOnEmptyTxBytes() public {
        vm.expectRevert(EdgeScoutSignalStore.EmptyTransactionBytes.selector);
        _attest(HEADER_NUMBER, TX_INDEX, TX_HASH, "");
    }

    function test_RevertsOnOutOfRangeChainKey() public {
        uint256 tooBig = uint256(type(uint64).max) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(EdgeScoutSignalStore.ValueOutOfRange.selector, tooBig)
        );
        store.attestTx(
            tooBig,
            HEADER_NUMBER,
            TX_INDEX,
            TX_HASH,
            _txBytes(1, 1, TRANSFER_TOPIC),
            _merkleProof(),
            _continuityProof()
        );
    }

    function test_RevertsOnOutOfRangeHeaderNumber() public {
        uint256 tooBig = uint256(type(uint64).max) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(EdgeScoutSignalStore.ValueOutOfRange.selector, tooBig)
        );
        _attest(tooBig, TX_INDEX, TX_HASH, _txBytes(1, 1, TRANSFER_TOPIC));
    }

    function test_RevertsOnOutOfRangeTxIndex() public {
        uint256 tooBig = uint256(type(uint32).max) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(EdgeScoutSignalStore.ValueOutOfRange.selector, tooBig)
        );
        _attest(HEADER_NUMBER, tooBig, TX_HASH, _txBytes(1, 1, TRANSFER_TOPIC));
    }

    function test_LatestSignalRevertsWhileEmpty() public {
        vm.expectRevert(EdgeScoutSignalStore.NoSignalsStored.selector);
        store.latestSignal();
    }

    function test_ReentrantPrecompileCannotStealTheReservedIndex() public {
        _useProver(address(new ReentrantBlockProver()));
        // The stub re-enters `attestTx`; the guard rejects it, the stub asserts that, and the
        // outer call still completes and stores exactly one fact at the reserved index 0.
        _attestDefault();
        assertEq(store.signalCount(), 1);
        assertEq(store.latestSignal().txHash, TX_HASH);
    }

    // --- capacity ----------------------------------------------------------------------------

    function test_RevertsWhenLedgerIsFull() public {
        bytes memory txBytes = _txBytes(1, 1, TRANSFER_TOPIC);
        uint256 cap = store.MAX_SIGNALS();
        for (uint256 i; i < cap; ++i) {
            _attest(HEADER_NUMBER, TX_INDEX, bytes32(i + 1), txBytes);
        }
        assertEq(store.signalCount(), cap);
        assertEq(store.remainingCapacity(), 0);

        vm.expectRevert(abi.encodeWithSelector(EdgeScoutSignalStore.SignalStoreFull.selector, cap));
        _attest(HEADER_NUMBER, TX_INDEX, bytes32(cap + 1), txBytes);
    }
}
