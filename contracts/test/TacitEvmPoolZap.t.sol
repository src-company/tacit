// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter} from "../src/TacitEvmPoolRouter.sol";
import {TacitEvmPoolZap, ISignatureTransfer} from "../src/TacitEvmPoolZap.sol";
import {MockUSDC} from "./ConfidentialRouter.t.sol";
import {AcceptTransact} from "./TacitEvmPool.t.sol";
import {TxBuilder, MockZRouterToEth} from "./TacitEvmPoolRouter.t.sol";

/// Permit2's signature transfer, with the signature stood in for by abi.encode(owner, spender, nonce): only a
/// "signature" made for this owner and spender pulls, and each nonce once.
contract MockSignatureTransfer {
    mapping(address => mapping(uint256 => bool)) public used;

    function permitTransferFrom(
        ISignatureTransfer.PermitTransferFrom calldata p,
        ISignatureTransfer.SignatureTransferDetails calldata d,
        address owner,
        bytes calldata signature
    ) external {
        require(keccak256(signature) == keccak256(abi.encode(owner, msg.sender, p.nonce)), "P2: bad signature");
        require(block.timestamp <= p.deadline && d.requestedAmount <= p.permitted.amount, "P2: bad permit");
        require(!used[owner][p.nonce], "P2: nonce used");
        used[owner][p.nonce] = true;
        SafeTransferLib.safeTransferFrom(p.permitted.token, owner, d.to, d.requestedAmount);
    }
}

/// A swap that calls back into the zap before paying.
contract ReenteringZRouter {
    TacitEvmPoolZap public zap;
    bytes public again;

    function arm(TacitEvmPoolZap z, bytes calldata data) external {
        zap = z;
        again = data;
    }

    function swap() external {
        (bool ok, bytes memory ret) = address(zap).call(again);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

contract TacitEvmPoolZapTest is TxBuilder {
    uint256 constant USER_PK = 0xA11CE;
    address user;
    address mallory = makeAddr("mallory");
    MockUSDC usdc;
    TacitEvmPool ethPool;
    MockZRouterToEth zr;
    MockSignatureTransfer permit2;
    TacitEvmPoolZap zap;

    function setUp() public {
        vm.chainId(1);
        user = vm.addr(USER_PK);
        usdc = new MockUSDC();
        ethPool = new TacitEvmPool(address(new AcceptTransact()), address(0));
        zr = new MockZRouterToEth();
        vm.deal(address(zr), 100 ether);
        permit2 = new MockSignatureTransfer();
        zap = new TacitEvmPoolZap(address(ethPool), address(zr), address(permit2));
        usdc.mint(user, 1_000_000);
        usdc.mint(mallory, 1_000_000);
        vm.deal(user, 1 ether);
    }

    function _deposit(uint256 amount) internal view returns (TacitEvmPoolZap.Tx memory) {
        return _zt(_tx(ethPool, 11, 0, _leaves(1, 0), address(0), int256(amount), address(0), 0, "", ""));
    }

    function _zt(TacitEvmPoolRouter.Tx memory t) internal pure returns (TacitEvmPoolZap.Tx memory) {
        return abi.decode(abi.encode(t), (TacitEvmPoolZap.Tx));
    }

    function _swap(uint256 inAmount, uint256 outAmount) internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockZRouterToEth.swapTokenForETH.selector, address(usdc), inAmount, outAmount);
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        user, address(zap), value, usdc.nonces(user), deadline
                    )
                )
            )
        );
        (v, r, s) = vm.sign(USER_PK, digest);
    }

    function _clean() internal view {
        assertEq(address(zap).balance, 0, "zap holds no ETH");
        assertEq(usdc.balanceOf(address(zap)), 0, "zap holds no token");
        assertEq(usdc.allowance(address(zap), address(zr)), 0, "zRouter allowance reset");
    }

    // ──────────────────── the three ways in ────────────────────

    function test_zapToken_with_an_allowance() public {
        vm.startPrank(user);
        usdc.approve(address(zap), 6000);
        zap.zapToken(_deposit(1 ether), address(usdc), 6000, _swap(5000, 1.2 ether));
        vm.stopPrank();
        assertEq(address(ethPool).balance, 1 ether, "exactly the deposit");
        assertEq(ethPool.nextIndex(), 2);
        assertEq(user.balance, 1.2 ether, "ETH above the deposit back to the caller");
        assertEq(usdc.balanceOf(user), 1_000_000 - 5000, "unspent input back to the caller");
        assertEq(usdc.allowance(user, address(zap)), 0);
        _clean();
    }

    function test_zapTokenWithPermit() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(6000, deadline);
        (TacitEvmPoolZap.Tx memory t, bytes memory swap) = (_deposit(1 ether), _swap(6000, 1 ether));
        vm.prank(user);
        zap.zapTokenWithPermit(t, address(usdc), 6000, deadline, v, r, s, swap);
        assertEq(address(ethPool).balance, 1 ether);
        assertEq(usdc.balanceOf(user), 1_000_000 - 6000);
        _clean();
    }

    function test_zapTokenWithPermit_survives_the_permit_sent_first() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(6000, deadline);
        // Copied from the mempool and sent on its own: the allowance it sets is still the caller's to use.
        vm.prank(mallory);
        usdc.permit(user, address(zap), 6000, deadline, v, r, s);
        (TacitEvmPoolZap.Tx memory t, bytes memory swap) = (_deposit(1 ether), _swap(6000, 1 ether));
        vm.prank(user);
        zap.zapTokenWithPermit(t, address(usdc), 6000, deadline, v, r, s, swap);
        assertEq(address(ethPool).balance, 1 ether);
        _clean();
    }

    function test_zapTokenWithPermit2() public {
        vm.startPrank(user);
        usdc.approve(address(permit2), type(uint256).max);
        bytes memory sig = abi.encode(user, address(zap), uint256(7));
        zap.zapTokenWithPermit2(_deposit(1 ether), address(usdc), 6000, 7, block.timestamp + 1 hours, sig, _swap(5500, 1 ether));
        vm.stopPrank();
        assertEq(address(ethPool).balance, 1 ether);
        assertEq(usdc.balanceOf(user), 1_000_000 - 5500);
        _clean();
    }

    // ──────────────────── only the caller's own tokens ────────────────────

    function test_an_allowance_is_usable_only_by_its_owner() public {
        vm.prank(user);
        usdc.approve(address(zap), 6000);
        // Mallory's zap pulls from Mallory, never from the user who approved: without an allowance of her own it fails.
        (TacitEvmPoolZap.Tx memory t, bytes memory swap) = (_deposit(1 ether), _swap(6000, 1 ether));
        vm.prank(mallory);
        vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
        zap.zapToken(t, address(usdc), 6000, swap);
        assertEq(usdc.balanceOf(user), 1_000_000);
        assertEq(usdc.allowance(user, address(zap)), 6000);
    }

    function test_a_permit2_signature_is_usable_only_by_its_signer() public {
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);
        bytes memory sig = abi.encode(user, address(zap), uint256(7));
        (TacitEvmPoolZap.Tx memory t, bytes memory swap) = (_deposit(1 ether), _swap(6000, 1 ether));
        vm.prank(mallory);
        vm.expectRevert(bytes("P2: bad signature"));
        zap.zapTokenWithPermit2(t, address(usdc), 6000, 7, block.timestamp + 1 hours, sig, swap);
        assertEq(usdc.balanceOf(user), 1_000_000);
    }

    // ──────────────────── all or nothing ────────────────────

    function test_a_short_swap_reverts_and_moves_nothing() public {
        vm.startPrank(user);
        usdc.approve(address(zap), 6000);
        (TacitEvmPoolZap.Tx memory t, bytes memory swap) = (_deposit(1 ether), _swap(6000, 1 ether - 1));
        vm.expectRevert(TacitEvmPoolZap.ShortSwapOutput.selector);
        zap.zapToken(t, address(usdc), 6000, swap);
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), 1_000_000);
        assertEq(address(ethPool).balance, 0);
    }

    function test_a_failed_deposit_reverts_and_moves_nothing() public {
        TacitEvmPoolZap.Tx memory t = _deposit(1 ether);
        t.publicInputs[1] = 12345; // proved against another head
        vm.startPrank(user);
        usdc.approve(address(zap), 6000);
        vm.expectRevert(TacitEvmPool.StaleRoot.selector);
        zap.zapToken(t, address(usdc), 6000, _swap(6000, 1 ether));
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), 1_000_000);
    }

    function test_a_failed_swap_reverts_with_its_reason() public {
        vm.startPrank(user);
        usdc.approve(address(zap), 6000);
        TacitEvmPoolZap.Tx memory t = _deposit(1 ether);
        vm.expectRevert(TacitEvmPoolZap.ZRouterCallFailed.selector);
        zap.zapToken(t, address(usdc), 6000, hex"deadbeef");
        vm.stopPrank();
    }

    function test_only_deposits() public {
        TacitEvmPoolZap.Tx memory out = _zt(_tx(ethPool, 11, 5, _leaves(1, 0), user, -1 ether, address(0), 0, "", ""));
        vm.startPrank(user);
        usdc.approve(address(zap), 6000);
        vm.expectRevert(TacitEvmPoolZap.NotADeposit.selector);
        zap.zapToken(out, address(usdc), 6000, _swap(6000, 1 ether));
        TacitEvmPoolZap.Tx memory none = _zt(_tx(ethPool, 11, 5, _leaves(1, 0), address(0), 0, address(0), 0, "", ""));
        vm.expectRevert(TacitEvmPoolZap.NotADeposit.selector);
        zap.zapToken(none, address(usdc), 6000, _swap(6000, 1 ether));
        vm.stopPrank();
    }

    function test_no_reentry() public {
        ReenteringZRouter bad = new ReenteringZRouter();
        TacitEvmPoolZap z = new TacitEvmPoolZap(address(ethPool), address(bad), address(permit2));
        bad.arm(z, abi.encodeCall(TacitEvmPoolZap.zapToken, (_deposit(1 ether), address(usdc), 1, "")));
        vm.startPrank(user);
        usdc.approve(address(z), 6000);
        TacitEvmPoolZap.Tx memory t = _deposit(1 ether);
        vm.expectRevert(TacitEvmPoolZap.Reentered.selector);
        z.zapToken(t, address(usdc), 6000, abi.encodeCall(ReenteringZRouter.swap, ()));
        vm.stopPrank();
    }

    function test_takes_ETH_only_during_a_zap() public {
        vm.prank(user);
        (bool ok,) = address(zap).call{value: 1}("");
        assertFalse(ok);
    }

    function test_constructor_wants_the_ETH_pool_and_live_periphery() public {
        TacitEvmPool tokenPool = new TacitEvmPool(address(new AcceptTransact()), address(usdc));
        vm.expectRevert(TacitEvmPoolZap.BadTarget.selector);
        new TacitEvmPoolZap(address(tokenPool), address(zr), address(permit2));
        vm.expectRevert(TacitEvmPoolZap.BadTarget.selector);
        new TacitEvmPoolZap(address(ethPool), makeAddr("no code"), address(permit2));
        vm.expectRevert(TacitEvmPoolZap.BadTarget.selector);
        new TacitEvmPoolZap(address(ethPool), address(zr), makeAddr("no code"));
    }
}
