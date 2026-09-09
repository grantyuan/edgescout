// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title SignalEmitter
 * @notice OPTIONAL source-chain companion contract for EdgeScout, meant for Ethereum Sepolia.
 *
 * @dev Not required for the default EdgeScout demo, and not part of the ASC itself.
 *
 *      Attestcoin attests *source chains*; on CC3 testnet those are Ethereum Sepolia
 *      (chainKey 1) and Ethereum Mainnet (chainKey 3). Somnia — where EdgeScout's markets
 *      live — is not an attested source chain, so an attested EdgeScout signal has to
 *      originate on Sepolia. There are two ways to get one:
 *
 *        (a) attest ANY existing Sepolia transaction (what the default demo does, using the
 *            official tutorial transaction), or
 *        (b) publish EdgeScout's own signal on Sepolia and attest that.
 *
 *      This contract is option (b): the smallest possible "source-chain smart contract" in the
 *      sense of docs.attestcoin.org → dApp Builder Infrastructure → Source Chain Smart
 *      Contracts. `emitSignal` writes a single event; the resulting Sepolia transaction hash
 *      is then fed to the prover API and to
 *      `EdgeScoutSignalStore.attestTx`, which records `Signal`'s topic 0 as `firstLogTopic`.
 *
 *      DEPLOYING THIS COSTS SEPOLIA ETH, which is a separate faucet from the Creditcoin
 *      tCTC faucet and a manual user action. It is deliberately kept out of the default
 *      deployment script (scripts/deploy-asc.mjs deploys the ASC on Creditcoin only).
 */
contract SignalEmitter {
    /**
     * @notice One EdgeScout signal published on the source chain.
     * @param reporter  Address that submitted the signal.
     * @param topic     Application-defined signal identifier, e.g.
     *                  `keccak256("edgescout.edge.v1")` or a market id.
     * @param sequence  Per-contract monotonic counter, so identical payloads stay distinct.
     * @param value     Signed fixed-point payload (EdgeScout uses basis points of edge).
     * @param timestamp Source-chain block timestamp at emission.
     */
    event Signal(
        address indexed reporter,
        bytes32 indexed topic,
        uint256 indexed sequence,
        int256 value,
        uint256 timestamp
    );

    /// @notice Number of signals emitted so far; also the next sequence number.
    uint256 public signalCount;

    /**
     * @notice Publish one signal and return its sequence number.
     * @dev Permissionless by design: the value is not trusted by consumers, it is merely made
     *      *attestable*. Trust comes from the Attestcoin proof plus the `reporter` topic, which
     *      lets EdgeScout filter for its own reporter address when decoding.
     * @param topic Application-defined signal identifier.
     * @param value Signal payload.
     * @return sequence The sequence number assigned to this signal.
     */
    function emitSignal(bytes32 topic, int256 value) external returns (uint256 sequence) {
        sequence = signalCount;
        unchecked {
            signalCount = sequence + 1;
        }
        emit Signal(msg.sender, topic, sequence, value, block.timestamp);
    }
}
