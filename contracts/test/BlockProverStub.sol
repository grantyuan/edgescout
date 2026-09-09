// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INativeQueryVerifier} from
    "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/**
 * @title Block Prover precompile stubs
 * @notice Test doubles for the Attestcoin Block Prover precompile at `0x0FD2`.
 *
 * @dev These are placed AT the real precompile address with `vm.etch`, so the tests exercise
 *      the production call path byte for byte: the ASC still builds the same calldata, calls
 *      the same address, and decodes the same return value. Only the verifier's answer is
 *      simulated, because a genuine answer would require the live Creditcoin attestor set.
 *
 *      Behaviour is encoded in the bytecode rather than in storage, because `vm.etch` copies
 *      runtime code only — the stub's own storage would not come along. Each test etches
 *      whichever variant it needs.
 */

/// @notice Accepts every proof, mirroring a genuine verification (event + `true`).
contract AcceptingBlockProver {
    event TransactionVerified(uint64 indexed chainKey, uint64 indexed height, uint64 transactionIndex);

    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external returns (bool) {
        emit TransactionVerified(chainKey, height, 0);
        return true;
    }
}

/// @notice Returns `false` without reverting — the ASC must reject this itself.
contract RejectingBlockProver {
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return false;
    }
}

/// @notice Reverts, which is how the real precompile rejects an invalid proof.
contract RevertingBlockProver {
    error InvalidProof();

    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        revert InvalidProof();
    }
}

/// @notice Attempts to re-enter the calling ASC, to prove the `nonReentrant` guard holds.
contract ReentrantBlockProver {
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata txBytes,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof
    ) external returns (bool) {
        // Call back into the ASC with a DIFFERENT query tuple, which would otherwise be
        // accepted and would steal the ledger index reserved by the outer call.
        (bool ok,) = msg.sender.call(
            abi.encodeWithSignature(
                "attestTx(uint256,uint256,uint256,bytes32,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))",
                uint256(1),
                uint256(999_999),
                uint256(7),
                bytes32(uint256(0xdead)),
                txBytes,
                merkleProof,
                continuityProof
            )
        );
        // The re-entry must have failed; surface it so the test can assert on it.
        require(!ok, "reentrancy unexpectedly succeeded");
        return true;
    }
}
