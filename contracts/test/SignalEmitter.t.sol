// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SignalEmitter} from "../src/SignalEmitter.sol";

/// @notice Tests for the optional Sepolia-side signal source. Offline, no network.
contract SignalEmitterTest is Test {
    SignalEmitter internal emitter;

    bytes32 internal constant TOPIC = keccak256("edgescout.edge.v1");

    event Signal(
        address indexed reporter,
        bytes32 indexed topic,
        uint256 indexed sequence,
        int256 value,
        uint256 timestamp
    );

    function setUp() public {
        emitter = new SignalEmitter();
        vm.warp(1_756_600_000);
    }

    function test_StartsAtZero() public view {
        assertEq(emitter.signalCount(), 0);
    }

    function test_EmitSignalReturnsAndAdvancesSequence() public {
        assertEq(emitter.emitSignal(TOPIC, 125), 0);
        assertEq(emitter.emitSignal(TOPIC, -40), 1);
        assertEq(emitter.signalCount(), 2);
    }

    function test_EmitSignalEmitsEventWithReporterAndTimestamp() public {
        address reporter = address(0xEDBE);
        vm.expectEmit(true, true, true, true, address(emitter));
        emit Signal(reporter, TOPIC, 0, 125, block.timestamp);
        vm.prank(reporter);
        emitter.emitSignal(TOPIC, 125);
    }

    function testFuzz_AnyPayloadIsAccepted(bytes32 topic, int256 value) public {
        uint256 sequence = emitter.emitSignal(topic, value);
        assertEq(sequence, 0);
        assertEq(emitter.signalCount(), 1);
    }
}
