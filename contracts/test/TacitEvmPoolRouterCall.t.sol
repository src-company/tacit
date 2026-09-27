// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter, TacitBox, IPoseidonT5} from "../src/TacitEvmPoolRouter.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";
import {TacitPublicAmm} from "../src/TacitPublicAmm.sol";
import {StubVerifier, MockUSDC, MockPermit2, MockZRouter} from "./ConfidentialRouter.t.sol";
import {AcceptTransact} from "./TacitEvmPool.t.sol";
import {TxBuilder} from "./TacitEvmPoolRouter.t.sol";
import {PoseidonT5Deploy} from "../script/PoseidonT5Deploy.sol";

/// A bridge entrypoint: takes ETH (or pulls a token) for a destination address and chain.
contract MockBridge {
    address public lastRecipient;
    uint256 public lastChain;
    uint256 public received;

    function depositETH(address recipient, uint256 destChain) external payable {
        lastRecipient = recipient;
        lastChain = destChain;
        received += msg.value;
    }

    function depositToken(address token, uint256 amount, address recipient) external {
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
        lastRecipient = recipient;
        received += amount;
    }
}

contract Reverter {
    error Nope();

    function go() external payable {
        revert Nope();
    }
}

/// Pulls less than it was approved, to show the escrow resets the leftover allowance.
contract PartialPuller {
    function pull(address token, uint256 amount) external {
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
    }
}

/// While the escrow runs it, tries to re-enter the router and to take the escrow's funds; records each outcome.
contract Reenterer {
    TacitEvmPoolRouter immutable router;
    TacitEvmPoolRouter.CallIntent intent;
    bool public reenteredExecute;
    bool public reenteredRefund;
    bool public releasedFromEscrow;
    uint256 public calls;

    constructor(TacitEvmPoolRouter r) {
        router = r;
    }

    function setIntent(TacitEvmPoolRouter.CallIntent calldata i) external {
        intent = i;
    }

    function poke() external payable {
        calls++;
        try router.executeCall(intent) {
            reenteredExecute = true;
        } catch {}
        try router.refundCall(intent, address(0)) {
            reenteredRefund = true;
        } catch {}
        try TacitBox(payable(msg.sender)).release(address(0), address(this), 1) {
            releasedFromEscrow = true;
        } catch {}
    }

    receive() external payable {}
}

contract TacitEvmPoolRouterCallTest is TxBuilder {
    bytes32 constant TETH_LINK = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant COMMIT = keccak256("v1-note-commit");
    bytes32 constant RECEIVE_TAG = keccak256("tacit-evm-pool-receive-box-v1");

    MockUSDC usdc;
    MockUSDC dai;
    TacitEvmPool ethPool;
    TacitEvmPool usdcPool;
    TacitEvmPoolRouter router;
    TacitEvmPoolRouter usdcRouter;
    MockZRouter zr;
    MockBridge bridge;
    ConfidentialPool v1;
    ConfidentialRouter v1Router;
    bytes32 usdcId;
    address poseidon4;
    address keeper = address(0x4EE9E5);
    address refund = address(0x5AFE);
    address payee = address(0xB0B);
    uint256 nf = 100;

    function setUp() public {
        vm.chainId(1);
        usdc = new MockUSDC();
        dai = new MockUSDC();
        address verifier = address(new AcceptTransact());
        ethPool = new TacitEvmPool(verifier, address(0));
        usdcPool = new TacitEvmPool(verifier, address(usdc));
        zr = new MockZRouter();
        bridge = new MockBridge();
        MockPermit2 permit2 = new MockPermit2();

        TacitPublicAmm amm = new TacitPublicAmm(address(this));
        v1 = new ConfidentialPool(
            address(new StubVerifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0), 0,
            bytes32(0), TETH_LINK, address(0), address(0), address(0), address(amm)
        );
        amm.initialize(address(v1));
        usdcId = v1.registerWrapped(address(usdc), 1, bytes32(0), "USD Coin", "USDC", 6);
        v1Router = new ConfidentialRouter(address(v1), address(amm), address(zr), address(permit2));

        poseidon4 = PoseidonT5Deploy.ensure();
        router = new TacitEvmPoolRouter(address(ethPool), address(zr), address(permit2), address(v1), poseidon4);
        usdcRouter = new TacitEvmPoolRouter(address(usdcPool), address(zr), address(permit2), address(v1), poseidon4);

        // Seed each pool so withdrawals have funds behind them.
        vm.deal(address(this), 100 ether);
        _send(ethPool, _tx(ethPool, 11, 0, _leaves(1, 0), address(0), 10 ether, address(0), 0, "", ""), 10 ether);
        usdc.mint(address(this), 1_000_000);
        usdc.approve(address(usdcPool), type(uint256).max);
        _send(usdcPool, _tx(usdcPool, 11, 0, _leaves(1, 0), address(0), 1_000_000, address(0), 0, "", ""), 0);
    }

    // ──────────────────── helpers ────────────────────

    function _call(address target, uint256 value, bytes memory data) internal pure returns (TacitEvmPoolRouter.Call memory c) {
        c.target = target;
        c.value = value;
        c.data = data;
    }

    function _intent(TacitEvmPoolRouter.Call memory c, address out, uint256 minOut)
        internal
        view
        returns (TacitEvmPoolRouter.CallIntent memory i)
    {
        i.calls = new TacitEvmPoolRouter.Call[](1);
        i.calls[0] = c;
        if (out != address(1)) {
            i.outTokens = new address[](1);
            i.outTokens[0] = out;
            i.minOuts = new uint256[](1);
            i.minOuts[0] = minOut;
        }
        i.to = payee;
        i.refund = refund;
        i.deadline = uint64(block.timestamp + 1 hours);
        i.nonce = 1;
    }

    /// A relayed withdrawal of `amount` into `i`'s escrow, paying the keeper `fee`.
    function _withdrawTx(TacitEvmPool p, TacitEvmPoolRouter r, TacitEvmPoolRouter.CallIntent memory i, uint256 amount, uint256 fee)
        internal
        returns (TacitEvmPoolRouter.Tx memory)
    {
        return _tx(p, 22, nf++, _noLeaves(), r.callEscrowOf(i), -int256(amount), keeper, fee, "", "");
    }

    function _swap(uint256 value, uint256 out) internal view returns (TacitEvmPoolRouter.Call memory) {
        return _call(address(zr), value, abi.encodeCall(MockZRouter.swapETHForToken, (address(usdc), out)));
    }

    // ──────────────────── withdraw and call ────────────────────

    function test_withdraw_swap_and_deliver_in_one_relayed_transaction() public {
        TacitEvmPoolRouter.CallIntent memory i = _intent(_swap(0.9 ether, 3000), address(usdc), 3000);
        TacitEvmPoolRouter.Tx memory t = _withdrawTx(ethPool, router, i, 0.95 ether, 0.01 ether);
        address escrow = router.callEscrowOf(i);
        vm.prank(keeper);
        router.withdrawAndCall(t, i);
        assertEq(usdc.balanceOf(payee), 3000, "swap output to `to`");
        assertEq(refund.balance, 0.05 ether, "unspent ETH to `refund`");
        assertEq(keeper.balance, 0.01 ether, "relayer fee from the pool");
        assertEq(escrow.balance, 0);
        assertEq(usdc.balanceOf(escrow), 0);
        assertEq(address(router).balance, 0);
        assertTrue(ethPool.nullified(bytes32(t.publicInputs[7])));
    }

    function test_withdraw_into_a_bridge_call_with_value() public {
        TacitEvmPoolRouter.CallIntent memory i =
            _intent(_call(address(bridge), 1 ether, abi.encodeCall(MockBridge.depositETH, (payee, 8453))), address(1), 0);
        router.withdrawAndCall(_withdrawTx(ethPool, router, i, 1 ether, 0), i);
        assertEq(address(bridge).balance, 1 ether);
        assertEq(bridge.lastRecipient(), payee);
        assertEq(bridge.lastChain(), 8453);
        assertEq(refund.balance, 0);
    }

    function test_withdraw_into_a_v1_shielded_token_note() public {
        // ETH → USDC through the V1 router's zap, wrapped into a V1 note for COMMIT; leftovers come back to the escrow.
        bytes memory zap = abi.encodeCall(
            ConfidentialRouter.zapETHToShieldedNote,
            (address(usdc), 5000, COMMIT, abi.encodeCall(MockZRouter.swapETHForToken, (address(usdc), 5100)))
        );
        TacitEvmPoolRouter.CallIntent memory i = _intent(_call(address(v1Router), 0.5 ether, zap), address(usdc), 0);
        router.withdrawAndCall(_withdrawTx(ethPool, router, i, 0.5 ether, 0), i);
        assertEq(usdc.balanceOf(address(v1)), 5000, "wrapped into V1");
        assertEq(usdc.balanceOf(payee), 100, "swap surplus to `to`");
        assertEq(usdc.balanceOf(address(v1Router)), 0);
    }

    function test_withdraw_into_v1_by_approve_and_wrap() public {
        TacitEvmPoolRouter.CallIntent memory i = _intent(_swap(0.2 ether, 7000), address(1), 0);
        TacitEvmPoolRouter.Call[] memory calls = new TacitEvmPoolRouter.Call[](2);
        calls[0] = i.calls[0];
        calls[1] = _call(address(v1), 0, abi.encodeCall(ConfidentialPool.wrap, (usdcId, 7000, COMMIT)));
        calls[1].token = address(usdc);
        calls[1].amount = 7000;
        i.calls = calls;
        address escrow = router.callEscrowOf(i);
        router.withdrawAndCall(_withdrawTx(ethPool, router, i, 0.2 ether, 0), i);
        assertEq(usdc.balanceOf(address(v1)), 7000);
        assertEq(usdc.allowance(escrow, address(v1)), 0);
    }

    function test_token_pool_withdraw_and_call_resets_unspent_approvals() public {
        PartialPuller puller = new PartialPuller();
        TacitEvmPoolRouter.Call memory c = _call(address(puller), 0, abi.encodeCall(PartialPuller.pull, (address(usdc), 600)));
        c.token = address(usdc);
        c.amount = 1000;
        TacitEvmPoolRouter.CallIntent memory i = _intent(c, address(1), 0);
        address escrow = usdcRouter.callEscrowOf(i);
        usdcRouter.withdrawAndCall(_withdrawTx(usdcPool, usdcRouter, i, 1000, 5), i);
        assertEq(usdc.balanceOf(address(puller)), 600);
        assertEq(usdc.balanceOf(refund), 400, "unpulled pool asset to `refund`");
        assertEq(usdc.balanceOf(keeper), 5);
        assertEq(usdc.allowance(escrow, address(puller)), 0);
    }

    function test_relayer_cannot_change_the_intent() public {
        TacitEvmPoolRouter.CallIntent memory i = _intent(_swap(1 ether, 3000), address(usdc), 3000);
        TacitEvmPoolRouter.Tx memory t = _withdrawTx(ethPool, router, i, 1 ether, 0);
        TacitEvmPoolRouter.CallIntent memory other = _intent(_swap(1 ether, 3000), address(usdc), 3000);
        other.to = keeper;
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.withdrawAndCall(t, other);
        other = _intent(_swap(1 ether, 3000), address(usdc), 1);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.withdrawAndCall(t, other);
        TacitEvmPoolRouter.Tx memory dep = _tx(ethPool, 22, 7, _leaves(3, 0), router.callEscrowOf(i), 1, keeper, 0, "", "");
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.withdrawAndCall(dep, i);
    }

    function test_a_failed_call_spends_nothing() public {
        TacitEvmPoolRouter.CallIntent memory i = _intent(_call(address(new Reverter()), 1 ether, abi.encodeCall(Reverter.go, ())), address(1), 0);
        TacitEvmPoolRouter.Tx memory t = _withdrawTx(ethPool, router, i, 1 ether, 0.01 ether);
        vm.expectRevert(Reverter.Nope.selector);
        router.withdrawAndCall(t, i);
        assertFalse(ethPool.nullified(bytes32(t.publicInputs[7])), "the note is still unspent");
        assertEq(address(ethPool).balance, 10 ether);
    }

    function test_a_short_output_spends_nothing() public {
        TacitEvmPoolRouter.CallIntent memory i = _intent(_swap(1 ether, 2999), address(usdc), 3000);
        TacitEvmPoolRouter.Tx memory t = _withdrawTx(ethPool, router, i, 1 ether, 0);
        vm.expectRevert(TacitBox.ShortOutput.selector);
        router.withdrawAndCall(t, i);
        assertFalse(ethPool.nullified(bytes32(t.publicInputs[7])));
    }

    function test_an_expired_intent_spends_nothing() public {
        TacitEvmPoolRouter.CallIntent memory i = _intent(_swap(1 ether, 3000), address(usdc), 3000);
        TacitEvmPoolRouter.Tx memory t = _withdrawTx(ethPool, router, i, 1 ether, 0);
        vm.warp(i.deadline + 1);
        vm.expectRevert(TacitEvmPoolRouter.Expired.selector);
        router.withdrawAndCall(t, i);
    }

    function test_intent_shape_rules() public {
        TacitEvmPoolRouter.CallIntent memory i = _intent(_swap(1 ether, 3000), address(usdc), 3000);
        i.refund = address(0);
        TacitEvmPoolRouter.Tx memory t = _withdrawTx(ethPool, router, i, 1 ether, 0);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.withdrawAndCall(t, i);

        i = _intent(_swap(1 ether, 3000), address(usdc), 3000);
        i.to = address(0);
        t = _withdrawTx(ethPool, router, i, 1 ether, 0);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.withdrawAndCall(t, i);

        i = _intent(_swap(1 ether, 3000), address(usdc), 3000);
        i.minOuts = new uint256[](0);
        t = _withdrawTx(ethPool, router, i, 1 ether, 0);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.withdrawAndCall(t, i);
    }

    function test_calls_cannot_target_the_pool_or_the_router() public {
        address[2] memory bad = [address(ethPool), address(router)];
        for (uint256 k; k < 2; ++k) {
            TacitEvmPoolRouter.CallIntent memory i = _intent(_call(bad[k], 0, ""), address(1), 0);
            TacitEvmPoolRouter.Tx memory t = _withdrawTx(ethPool, router, i, 1 ether, 0);
            vm.expectRevert(TacitBox.BadTarget.selector);
            router.withdrawAndCall(t, i);
        }
    }

    function test_a_called_target_cannot_reenter_or_take_the_escrow() public {
        Reenterer r = new Reenterer(router);
        TacitEvmPoolRouter.CallIntent memory i = _intent(_call(address(r), 0.4 ether, abi.encodeCall(Reenterer.poke, ())), address(1), 0);
        r.setIntent(i);
        router.withdrawAndCall(_withdrawTx(ethPool, router, i, 1 ether, 0), i);
        assertEq(r.calls(), 1);
        assertFalse(r.reenteredExecute(), "executeCall re-entry refused");
        assertFalse(r.reenteredRefund(), "refundCall re-entry refused");
        assertFalse(r.releasedFromEscrow(), "only the router moves escrow funds");
        assertEq(address(r).balance, 0.4 ether);
        assertEq(refund.balance, 0.6 ether);
    }

    // ──────────────────── an escrow paid without being run ────────────────────

    function test_withdrawal_sent_to_the_pool_directly_is_run_by_anyone() public {
        TacitEvmPoolRouter.CallIntent memory i = _intent(_swap(1 ether, 3000), address(usdc), 3000);
        vm.expectRevert(TacitEvmPoolRouter.EscrowEmpty.selector);
        router.executeCall(i);
        _send(ethPool, _withdrawTx(ethPool, router, i, 1 ether, 0.01 ether), 0); // the proof, submitted straight to the pool
        assertEq(router.callEscrowOf(i).balance, 1 ether);
        vm.prank(address(0xC0FFEE));
        router.executeCall(i);
        assertEq(usdc.balanceOf(payee), 3000);
        vm.expectRevert(TacitEvmPoolRouter.EscrowEmpty.selector);
        router.executeCall(i);
    }

    function test_unrun_escrow_refunds_into_a_receive_box_and_back_into_the_pool() public {
        uint256 npk = 0xABCDEF;
        address box = router.receiveBoxOf(npk, 25);
        TacitEvmPoolRouter.CallIntent memory i = _intent(_swap(1 ether, 3000), address(usdc), 3000);
        i.refund = box;
        _send(ethPool, _withdrawTx(ethPool, router, i, 1 ether, 0), 0);

        vm.expectRevert(TacitEvmPoolRouter.NotExpired.selector);
        router.refundCall(i, address(0));
        vm.warp(i.deadline + 1);
        vm.expectRevert(TacitEvmPoolRouter.Expired.selector);
        router.executeCall(i);
        router.refundCall(i, address(0));
        assertEq(box.balance, 1 ether);

        uint256 rho = uint256(keccak256(abi.encode(RECEIVE_TAG, box, uint256(0)))) % P;
        uint256 assetField = uint256(keccak256(abi.encode(block.chainid, address(ethPool), address(0)))) % P;
        uint256 leaf = IPoseidonT5(poseidon4).hash([assetField, 1 ether - 0.0025 ether, npk, rho]);
        uint256 poolBefore = address(ethPool).balance;
        router.sweepReceive(npk, 25, _tx(ethPool, 33, 0, _leaves(leaf, 0), address(0), 1 ether, keeper, 0.0025 ether, "", ""));
        assertEq(address(ethPool).balance, poolBefore + 0.9975 ether, "the refund is a note again");
    }

    // ──────────────────── the V1 exit-recipe escrow, for comparison ────────────────────

    function test_v1_exit_recipe_escrow_also_takes_a_pool_withdrawal() public {
        ConfidentialRouter.ExitRecipe memory recipe;
        recipe.exitedAsset = TETH_LINK;
        recipe.finalRecipient = payee;
        recipe.deadline = uint64(block.timestamp + 1 hours);
        recipe.nonce = 1;
        recipe.calls = new ConfidentialRouter.ExitCall[](1);
        recipe.calls[0] = ConfidentialRouter.ExitCall({
            target: address(zr), value: 1 ether, token: address(0), amount: 0, push: false,
            data: abi.encodeCall(MockZRouter.swapETHForToken, (address(usdc), 3000))
        });
        recipe.sweepTokens = new address[](1);
        recipe.sweepTokens[0] = address(usdc);
        recipe.minOuts = new uint256[](1);
        recipe.minOuts[0] = 3000;
        address escrow = v1Router.escrowAddressFor(recipe);
        _send(ethPool, _tx(ethPool, 22, 9, _noLeaves(), escrow, -1 ether, keeper, 0, "", ""), 0);
        v1Router.activateExit(recipe); // a second transaction, by anyone
        assertEq(usdc.balanceOf(payee), 3000);
    }

    // ──────────────────── funding with a call ────────────────────

    function _depositIntent(uint256 amount) internal view returns (TacitEvmPoolRouter.DepositIntent memory d) {
        d.amount = amount;
        d.outLeaf0 = 41;
        d.memo0Hash = keccak256("");
        d.memo1Hash = keccak256("");
        d.refund = refund;
        d.deadline = uint64(block.timestamp + 1 days);
        d.nonce = 3;
    }

    function test_fundDeposit_pays_the_box_and_publishes_the_hint() public {
        TacitEvmPoolRouter.DepositIntent memory d = _depositIntent(1 ether);
        address box = router.depositBoxOf(d);
        vm.expectEmit(address(router));
        emit TacitEvmPoolRouter.DepositFunded(box, d, hex"c0ffee");
        router.fundDeposit{value: 1 ether}(d, hex"c0ffee");
        assertEq(box.balance, 1 ether);

        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.fundDeposit{value: 1 ether}(d, ""); // already paid

        vm.prank(keeper);
        router.completeDeposit(d, _tx(ethPool, 44, 0, _leaves(41, 0), address(0), 1 ether, keeper, 0, "", ""));
        assertEq(box.balance, 0);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.fundDeposit{value: 1 ether}(d, ""); // completed
    }

    /// Byte vectors from dapp/evm-pool-gateway.js (encodeDepositHint, v1ZapShieldedNoteCall).
    function test_gateway_encodings_match_solidity() public pure {
        assertEq(
            abi.encode(uint256(990), uint256(5), uint256(6), uint256(0), uint256(0), uint256(0), hex"a11ce0", hex""),
            hex"00000000000000000000000000000000000000000000000000000000000003de00000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000003a11ce000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );
        assertEq(
            abi.encodeCall(
                ConfidentialRouter.zapETHToShieldedNote,
                (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 5, bytes32(0x1111111111111111111111111111111111111111111111111111111111111111), hex"abcd")
            ),
            hex"65dcbb8e000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000000005111111111111111111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000002abcd000000000000000000000000000000000000000000000000000000000000"
        );
    }

    function test_fundDeposit_rules() public {
        TacitEvmPoolRouter.DepositIntent memory d = _depositIntent(1 ether);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.fundDeposit{value: 0.5 ether}(d, "");
        d.refund = address(0);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.fundDeposit{value: 1 ether}(d, "");
        d = _depositIntent(1 ether);
        vm.warp(d.deadline + 1);
        vm.expectRevert(TacitEvmPoolRouter.Expired.selector);
        router.fundDeposit{value: 1 ether}(d, "");
    }

    function test_fundDeposit_pulls_the_pool_token() public {
        TacitEvmPoolRouter.DepositIntent memory d = _depositIntent(700);
        usdc.mint(payee, 700);
        vm.deal(payee, 1);
        vm.startPrank(payee);
        usdc.approve(address(usdcRouter), 700);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        usdcRouter.fundDeposit{value: 1}(d, "");
        usdcRouter.fundDeposit(d, "");
        vm.stopPrank();
        assertEq(usdc.balanceOf(usdcRouter.depositBoxOf(d)), 700);
    }

    function test_fundReceive_pays_and_announces_the_box() public {
        uint256 npk = 0x1234;
        address box = router.receiveBoxOf(npk, 25);
        vm.expectEmit(address(router));
        emit TacitEvmPoolRouter.ReceiveFunded(box, npk, 25, 2 ether);
        router.fundReceive{value: 2 ether}(npk, 25, 2 ether);
        router.fundReceive{value: 1 ether}(npk, 25, 1 ether);
        assertEq(box.balance, 3 ether);

        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.fundReceive{value: 1}(0, 25, 1);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.fundReceive{value: 1}(P, 25, 1);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.fundReceive{value: 1}(npk, 10_001, 1);
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.fundReceive{value: 2}(npk, 25, 1);
    }
}
