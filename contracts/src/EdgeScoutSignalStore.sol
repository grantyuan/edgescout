// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INativeQueryVerifier} from
    "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";

/**
 * @title EdgeScoutSignalStore
 * @notice EdgeScout's ASC (Attestcoin Smart Contract) on Creditcoin CC3: a ledger of
 *         source-chain facts that were proven, on-chain and synchronously, by the
 *         Attestcoin Block Prover precompile at `0x0FD2`.
 *
 * @dev This contract is the WRITE half of EdgeScout's Attestcoin integration. The READ half
 *      (src/lib/attest.ts) verifies proofs off-chain with a free `eth_call`; that proves
 *      inclusion but leaves no trace. This contract turns a verified proof into durable,
 *      publicly readable on-chain state that the EdgeScout dashboard consumes through
 *      `/api/asc` — so an attested Sepolia signal becomes a fact any third party can audit.
 *
 *      It follows the canonical ASC pattern documented by Gluwa
 *      (docs.attestcoin.org → dApp Builder Infrastructure → Attestcoin Smart Contracts):
 *
 *        1. an off-chain worker fetches the Merkle + continuity proof from the prover API,
 *        2. the worker calls the ASC entry point `attestTx`,
 *        3. the ASC computes a query id and enforces replay protection,
 *        4. the ASC calls the precompile (`verifyAndEmit`) — the call reverts, or returns
 *           false, when the proof does not hold,
 *        5. the ASC decodes the attested transaction bytes and executes business logic.
 *
 *      Two protocol rules are honoured explicitly:
 *      - The precompile proves *inclusion only*. Receipt success is NOT part of that proof,
 *        so this contract checks `receiptStatus == 1` itself and rejects failed source
 *        transactions (a reverted source transaction carries no usable signal).
 *      - Replay protection is the ASC's own responsibility; `queryId` is the guard.
 *
 * @custom:security-contact The deployment key is a throwaway testnet key. This contract holds
 *         no funds, has no owner and no upgrade path: `attestTx` is permissionless, and the
 *         only thing an attacker can do is spend their own tCTC to record a genuinely
 *         attested source-chain fact.
 */
contract EdgeScoutSignalStore {
    // --- constants -----------------------------------------------------------------------

    /// @notice Attestcoin Block Prover precompile (4050 = 0xFD2) on Creditcoin CC3.
    address public constant BLOCK_PROVER_PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    /// @notice Receipt status of a successful source-chain transaction.
    uint8 public constant RECEIPT_STATUS_SUCCESS = 1;

    /**
     * @notice Hard cap on stored facts.
     * @dev The ledger is append-only and never pruned, so it is bounded to keep the testnet
     *      demo cheap and to give the array a provable upper bound. 1000 facts is far beyond
     *      what a hackathon demo (funded by a 100 tCTC/24h faucet) can ever write.
     */
    uint256 public constant MAX_SIGNALS = 1000;

    // --- types ---------------------------------------------------------------------------

    /**
     * @notice One verified source-chain fact.
     * @dev Field order is chosen for storage packing, not for readability: the first six
     *      fields occupy exactly one 32-byte slot (64+64+32+32+48+8 = 248 bits), so a fact
     *      costs 3 slots instead of 8. Widths are sized against the protocol:
     *      `chainKey`/`headerNumber` are `uint64` in the precompile ABI itself, a block can
     *      not hold 2^32 transactions, and `uint48` timestamps overflow in year 8,921,556.
     *
     * @param chainKey       Attestcoin source-chain key (1 = Ethereum Sepolia, 3 = Mainnet).
     * @param headerNumber   Source-chain block height that includes the transaction.
     * @param txIndex        Index of the transaction inside that block.
     * @param logCount       Number of logs in the attested receipt.
     * @param storedAt       Creditcoin `block.timestamp` at which the fact was recorded.
     * @param receiptStatus  Source-chain receipt status. Always 1: `attestTx` rejects failed
     *                       source transactions. Stored anyway so a consumer reads the proven
     *                       value instead of trusting an assumption.
     * @param txHash         Source-chain transaction hash, as supplied by the caller.
     * @param firstLogTopic  Topic 0 (the event signature) of the receipt's first log, or
     *                       `bytes32(0)` when the receipt has no logs / no topics.
     */
    struct StoredFact {
        uint64 chainKey;
        uint64 headerNumber;
        uint32 txIndex;
        uint32 logCount;
        uint48 storedAt;
        uint8 receiptStatus;
        bytes32 txHash;
        bytes32 firstLogTopic;
    }

    // --- storage -------------------------------------------------------------------------

    /// @notice Append-only ledger of verified facts. Also the ABI getter `signals(uint256)`.
    StoredFact[] public signals;

    /**
     * @dev Replay guard and index: `queryId => (position in `signals`) + 1`. The +1 offset
     *      keeps 0 meaning "never processed", so one 32-byte slot per query replaces a second
     *      full copy of the fact.
     */
    mapping(bytes32 => uint256) private _queryIndexPlusOne;

    /**
     * @dev Reentrancy guard, 1 = not entered / 2 = entered (never zeroed, so the slot stays
     *      warm and the guard costs ~100 gas after the first call). The Block Prover is a
     *      native precompile and cannot call back, but `attestTx` still performs an external
     *      call before its final storage write, and the reserved-index bookkeeping below is
     *      only exact while no nested `attestTx` can push to `signals`.
     */
    uint256 private _reentrancyStatus = _NOT_ENTERED;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // --- modifiers -----------------------------------------------------------------------

    // Used once by design: `attestTx` is the only state-changing entry point.
    // forge-lint: disable-next-line(modifier-used-only-once)
    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert ReentrantCall();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    // --- events --------------------------------------------------------------------------

    /**
     * @notice Emitted once per newly recorded fact.
     * @dev The precompile emits its own `TransactionVerified` event in the same transaction;
     *      this event is the application-level counterpart that EdgeScout indexes.
     */
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

    // --- errors --------------------------------------------------------------------------

    /// @notice This exact (chainKey, headerNumber, txIndex, txHash) tuple was already stored.
    error QueryAlreadyProcessed(bytes32 queryId);

    /// @notice The ledger reached `MAX_SIGNALS`.
    error SignalStoreFull(uint256 cap);

    /// @notice The precompile answered `false` instead of reverting.
    error ProofRejected(bytes32 queryId);

    /// @notice The source transaction is genuinely included but its receipt reverted.
    error SourceTransactionFailed(uint8 receiptStatus);

    /// @notice `txBytes` was empty; the decoder needs the ABI-encoded transaction.
    error EmptyTransactionBytes();

    /// @notice A caller-supplied value does not fit the precompile / storage width.
    error ValueOutOfRange(uint256 value);

    /// @notice `latestSignal()` was called on an empty ledger.
    error NoSignalsStored();

    /// @notice `attestTx` was re-entered.
    error ReentrantCall();

    /// @dev Internal invariant: the reserved ledger index no longer matches the array length.
    error IndexReservationBroken(uint256 expected, uint256 actual);

    // --- entry point ---------------------------------------------------------------------

    /**
     * @notice Verify a source-chain transaction against the Attestcoin attestor set and, on
     *         success, record it as a permanent fact.
     * @dev Reverts unless the proof holds — nothing is stored on a failed verification.
     *      Costs tCTC (this is the only write path in EdgeScout's integration).
     *
     *      Arguments 1-4 are `uint256`/`bytes32` for caller ergonomics (they come straight
     *      from the prover JSON through ethers); they are range-checked and narrowed before
     *      they reach the precompile ABI (`uint64`) and storage.
     *
     * @param chainKey        Attestcoin source-chain key (1 = Sepolia on CC3 testnet).
     * @param headerNumber    Source-chain block height holding the transaction.
     * @param txIndex         Transaction index within that block.
     * @param txHash          Source-chain transaction hash (identity only — the cryptographic
     *                        binding comes from `txBytes` + the Merkle proof).
     * @param txBytes         ABI-encoded transaction + receipt from the prover API.
     * @param merkleProof     Transaction-inclusion proof for `headerNumber`.
     * @param continuityProof Chain linking `headerNumber` back to an attested checkpoint.
     * @return queryId        Identifier of the stored fact.
     */
    function attestTx(
        uint256 chainKey,
        uint256 headerNumber,
        uint256 txIndex,
        bytes32 txHash,
        bytes calldata txBytes,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof
    ) external nonReentrant returns (bytes32 queryId) {
        if (signals.length >= MAX_SIGNALS) revert SignalStoreFull(MAX_SIGNALS);
        if (txBytes.length == 0) revert EmptyTransactionBytes();
        if (chainKey > type(uint64).max) revert ValueOutOfRange(chainKey);
        if (headerNumber > type(uint64).max) revert ValueOutOfRange(headerNumber);
        if (txIndex > type(uint32).max) revert ValueOutOfRange(txIndex);

        // Narrow once, after the range checks above, so no later cast can truncate.
        uint64 narrowChainKey = uint64(chainKey);
        uint64 narrowHeaderNumber = uint64(headerNumber);
        uint32 narrowTxIndex = uint32(txIndex);

        // 1. Query identity + replay protection (before any external call).
        queryId = computeQueryId(chainKey, headerNumber, txIndex, txHash);
        if (_queryIndexPlusOne[queryId] != 0) revert QueryAlreadyProcessed(queryId);

        // 2. Effect before interaction (checks-effects-interactions): claim the query id and
        //    reserve the ledger slot it will occupy. Everything reverts together if the proof
        //    fails, and `nonReentrant` guarantees no nested call can take the reserved index.
        uint256 index = signals.length;
        _queryIndexPlusOne[queryId] = index + 1;

        // 3. Cryptographic verification by the Attestcoin precompile. `verifyAndEmit` is the
        //    state-changing variant: it reverts on an invalid proof and emits the protocol's
        //    own TransactionVerified event, which is what makes this call auditable on
        //    Blockscout. The bool is checked as well, so a future non-reverting precompile
        //    build can not silently store an unverified fact.
        // The guard flag is reset after this call because that is what a reentrancy guard
        // does; re-entry is rejected by `nonReentrant`, and the replay guard was already
        // written in step 2 above.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        bool verified = INativeQueryVerifier(BLOCK_PROVER_PRECOMPILE).verifyAndEmit(
            narrowChainKey, narrowHeaderNumber, txBytes, merkleProof, continuityProof
        );
        if (!verified) revert ProofRejected(queryId);

        // 4. Decode the attested transaction. The proof covers inclusion only, so the receipt
        //    status is checked here — this is an explicit protocol requirement for ASCs.
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(txBytes);
        if (receipt.receiptStatus != RECEIPT_STATUS_SUCCESS) {
            revert SourceTransactionFailed(receipt.receiptStatus);
        }

        uint32 logCount = uint32(receipt.receiptLogs.length);
        bytes32 firstLogTopic = bytes32(0);
        if (logCount != 0 && receipt.receiptLogs[0].topics.length != 0) {
            firstLogTopic = receipt.receiptLogs[0].topics[0];
        }

        // 5. Business logic: append the fact into the slot reserved in step 2.
        if (signals.length != index) revert IndexReservationBroken(index, signals.length);
        uint48 storedAt = uint48(block.timestamp);
        signals.push(
            StoredFact({
                chainKey: narrowChainKey,
                headerNumber: narrowHeaderNumber,
                txIndex: narrowTxIndex,
                logCount: logCount,
                storedAt: storedAt,
                receiptStatus: receipt.receiptStatus,
                txHash: txHash,
                firstLogTopic: firstLogTopic
            })
        );

        // Emitted after the precompile call because the event carries data decoded from the
        // verified transaction; `nonReentrant` prevents any interleaving.
        // forge-lint: disable-next-line(reentrancy-events)
        emit SignalStored(
            queryId,
            narrowChainKey,
            txHash,
            index,
            narrowHeaderNumber,
            narrowTxIndex,
            receipt.receiptStatus,
            logCount,
            firstLogTopic,
            storedAt
        );
    }

    // --- views ---------------------------------------------------------------------------

    /**
     * @notice Deterministic identity of one attestation query.
     * @dev Pure, so off-chain callers can precompute it and check `isProcessed` before
     *      spending gas. The off-chain twin lives in scripts/attest-on-asc.mjs, which computes
     *      the same hash with ethers and asserts it against this function before paying gas.
     */
    function computeQueryId(uint256 chainKey, uint256 headerNumber, uint256 txIndex, bytes32 txHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainKey, headerNumber, txIndex, txHash));
    }

    /// @notice Number of facts stored so far.
    function signalCount() external view returns (uint256) {
        return signals.length;
    }

    /// @notice Remaining capacity before `MAX_SIGNALS` is hit.
    function remainingCapacity() external view returns (uint256) {
        return MAX_SIGNALS - signals.length;
    }

    /**
     * @notice Most recently stored fact.
     * @dev Reverts when the ledger is empty; read `signalCount()` first.
     */
    function latestSignal() external view returns (StoredFact memory) {
        uint256 length = signals.length;
        if (length == 0) revert NoSignalsStored();
        return signals[length - 1];
    }

    /**
     * @notice Fact recorded for a query id.
     * @dev Returns an all-zero struct for an unknown query id (check `isProcessed` first).
     */
    function factOfQuery(bytes32 queryId) external view returns (StoredFact memory fact) {
        uint256 indexPlusOne = _queryIndexPlusOne[queryId];
        if (indexPlusOne == 0) return fact;
        return signals[indexPlusOne - 1];
    }

    /// @notice Whether this query id was already attested (replay-protection view).
    function isProcessed(bytes32 queryId) external view returns (bool) {
        return _queryIndexPlusOne[queryId] != 0;
    }

    /// @notice The Attestcoin precompile this ASC verifies against.
    function precompileAddress() external pure returns (address) {
        return BLOCK_PROVER_PRECOMPILE;
    }
}
