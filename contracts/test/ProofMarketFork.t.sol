// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProofMarket} from "../src/ProofMarket.sol";

interface ITac {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

contract PoolStub {
    uint256 public calls;

    function settle(bytes calldata, bytes calldata, bytes[] calldata) external {
        calls++;
    }
}

/// The live TAC token's own ERC-2612 permit, end to end through ProofMarket: a holder with no allowance and no gas
/// signs an intent and a permit; a prover settles and is paid in the same call. (The pool is a stub here: the real
/// pool's settle is exercised by tests/proofmarket-fork.mjs with the real guest.) Set FORK_URL to run.
contract ProofMarketForkTest is Test {
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;

    function test_liveTacPermitPaysTheProver() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) {
            emit log("FORK_URL unset - skipping live TAC fork test");
            return;
        }
        vm.createSelectFork(url);
        PoolStub pool = new PoolStub();
        ProofMarket mkt = new ProofMarket(address(pool), TAC, 60, address(0x0A11), address(0x7EA5));

        uint256 key = 0xB0B;
        address payer = vm.addr(key);
        deal(TAC, payer, 100e18);
        address solver = address(0x5017);

        bytes memory pv = hex"abcdef";
        ProofMarket.Intent memory i = ProofMarket.Intent(payer, keccak256(pv), 1e18, 5e18, uint64(block.timestamp), 0, uint64(block.timestamp + 1 hours), bytes32(0));
        bytes memory sig;
        {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, mkt.intentHash(i));
            sig = abi.encodePacked(r, s, v);
        }
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                payer,
                address(mkt),
                i.maxFee,
                ITac(TAC).nonces(payer),
                i.deadline
            )
        );
        (uint8 pv_, bytes32 pr, bytes32 ps) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", ITac(TAC).DOMAIN_SEPARATOR(), sh)));
        bytes[] memory memos = new bytes[](0);

        vm.deal(solver, 1 ether);
        vm.prank(solver);
        mkt.claim(i, sig);
        vm.prank(solver);
        mkt.fulfill(i, sig, pv, hex"", memos, pv_, pr, ps);

        assertEq(pool.calls(), 1);
        assertEq(ITac(TAC).balanceOf(solver), 5e18, "paid the max (ramp 0) in live TAC");
        assertEq(ITac(TAC).balanceOf(payer), 95e18);
    }
}
