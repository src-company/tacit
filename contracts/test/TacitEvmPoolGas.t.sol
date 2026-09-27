// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter, IPoseidonT5} from "../src/TacitEvmPoolRouter.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {TacitPublicAmm} from "../src/TacitPublicAmm.sol";
import {IPermit2} from "../src/ConfidentialRouter.sol";
import {StubVerifier, MockUSDC, MockPermit2, MockZRouter} from "./ConfidentialRouter.t.sol";
import {AcceptTransact, PoolToken} from "./TacitEvmPool.t.sol";
import {TxBuilder, MockZRouterToEth} from "./TacitEvmPoolRouter.t.sol";
import {TransactVerifierDev} from "./TransactVerifierDev.sol";
import {PoseidonT5Deploy} from "../script/PoseidonT5Deploy.sol";

/// Gas per pool and router path, one measured call per test. Run with `forge test --isolate -vv --match-contract
/// TacitEvmPoolGas` so each call is its own transaction (cold storage, as on chain). The pool runs behind an
/// accept-all verifier except in the real-proof suite.
abstract contract GasRecorder is Test {
    function _record(string memory name) internal {
        emit log_named_uint(name, vm.lastCallGas().gasTotalUsed);
    }
}

contract TacitEvmPoolGasTest is TxBuilder, GasRecorder {
    bytes32 constant TETH_LINK = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant RECEIVE_TAG = keccak256("tacit-evm-pool-receive-box-v1");
    uint256 constant NPK = 0x1234567890abcdef;

    TacitEvmPool ethPool;
    TacitEvmPool usdcPool;
    TacitEvmPoolRouter ethRouter;
    TacitEvmPoolRouter usdcRouter;
    MockUSDC usdc;
    MockPermit2 permit2;
    ConfidentialPool v1;
    address poseidon4;
    address user = address(0xA11CE);
    address keeper = address(0x4EE9E5);
    address constant RECIPIENT = address(0xC0FFEE);
    bytes memo = new bytes(65);

    function setUp() public {
        vm.chainId(1);
        address verifier = address(new AcceptTransact());
        usdc = new MockUSDC();
        ethPool = new TacitEvmPool(verifier, address(0));
        usdcPool = new TacitEvmPool(verifier, address(usdc));
        permit2 = new MockPermit2();
        MockZRouter zr = new MockZRouter();
        MockZRouterToEth zrEth = new MockZRouterToEth();
        vm.deal(address(zrEth), 100 ether);
        TacitPublicAmm amm = new TacitPublicAmm(address(this));
        v1 = new ConfidentialPool(
            address(new StubVerifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0), 0,
            bytes32(0), TETH_LINK, address(0), address(0), address(0), address(amm)
        );
        amm.initialize(address(v1));
        poseidon4 = PoseidonT5Deploy.ensure();
        ethRouter = new TacitEvmPoolRouter(address(ethPool), address(zrEth), address(permit2), address(v1), poseidon4);
        usdcRouter = new TacitEvmPoolRouter(address(usdcPool), address(zr), address(permit2), address(v1), poseidon4);
        vm.deal(user, 100 ether);
        usdc.mint(user, 1_000_000);
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        // A pool that already holds notes, so no measured call pays for first-ever storage writes.
        vm.prank(user);
        _send(ethPool, _tx(ethPool, 101, 0, _leaves(1, 2), address(0), 10 ether, address(0), 0, memo, memo), 10 ether);
        vm.startPrank(user);
        usdc.approve(address(usdcPool), type(uint256).max);
        _send(usdcPool, _tx(usdcPool, 101, 0, _leaves(1, 2), address(0), 10_000, address(0), 0, memo, memo), 0);
        vm.stopPrank();
    }

    function _txRoot(TacitEvmPool p, uint256 newRoot, uint256 nf0, uint256 nf1, uint256[2] memory leaves, address to, int256 ext, address relayer, uint256 fee)
        internal
        view
        returns (TacitEvmPoolRouter.Tx memory t)
    {
        t = _tx(p, newRoot, nf0, leaves, to, ext, relayer, fee, leaves[0] != 0 ? memo : bytes(""), leaves[1] != 0 ? memo : bytes(""));
        t.publicInputs[8] = nf1;
    }

    // ──────────────────── pool ────────────────────

    function test_gas_pool_deposit() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(ethPool, 202, 0, 0, _leaves(3, 4), address(0), 1 ether, address(0), 0);
        vm.prank(user);
        _send(ethPool, t, 1 ether);
        _record("pool_deposit");
    }

    function test_gas_pool_transfer_relayed() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(ethPool, 202, 11, 12, _leaves(3, 4), address(0), 0, keeper, 0.001 ether);
        vm.prank(keeper);
        _send(ethPool, t, 0);
        _record("pool_transfer_relayed");
    }

    function test_gas_pool_withdraw_with_change() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(ethPool, 202, 11, 12, _leaves(3, 0), RECIPIENT, -1 ether, address(0), 0);
        vm.prank(user);
        _send(ethPool, t, 0);
        _record("pool_withdraw_with_change");
    }

    function test_gas_pool_withdraw_relayed_no_change() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(ethPool, 202, 11, 12, _noLeaves(), RECIPIENT, -1 ether, keeper, 0.001 ether);
        vm.prank(keeper);
        _send(ethPool, t, 0);
        _record("pool_withdraw_relayed_no_change");
    }

    function test_gas_pool_withdraw_relayed_with_change() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(ethPool, 202, 11, 12, _leaves(3, 0), RECIPIENT, -1 ether, keeper, 0.001 ether);
        vm.prank(keeper);
        _send(ethPool, t, 0);
        _record("pool_withdraw_relayed_with_change");
    }

    function test_gas_pool_token_deposit() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(usdcPool, 202, 0, 0, _leaves(3, 4), address(0), 1000, address(0), 0);
        vm.prank(user);
        _send(usdcPool, t, 0);
        _record("pool_token_deposit");
    }

    function test_gas_pool_token_withdraw_relayed() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(usdcPool, 202, 11, 12, _leaves(3, 0), RECIPIENT, -1000, keeper, 10);
        vm.prank(keeper);
        _send(usdcPool, t, 0);
        _record("pool_token_withdraw_relayed");
    }

    // ──────────────────── router ────────────────────

    function _depositIntent(uint256 amount, uint256[2] memory leaves) internal view returns (TacitEvmPoolRouter.DepositIntent memory i) {
        i.amount = amount;
        i.outLeaf0 = leaves[0];
        i.outLeaf1 = leaves[1];
        i.memo0Hash = keccak256(memo);
        i.memo1Hash = keccak256(memo);
        i.refund = address(0x5AFE);
        i.deadline = uint64(block.timestamp + 1 days);
        i.nonce = 1;
    }

    function _wrapIntent(uint256 amount, uint256 tip) internal view returns (TacitEvmPoolRouter.WrapIntent memory w) {
        w.assetId = TETH_LINK;
        w.amount = amount;
        w.tip = tip;
        w.commit = keccak256("v1-note-commit");
        w.refund = address(0x5AFE);
        w.deadline = uint64(block.timestamp + 1 days);
        w.nonce = 7;
    }

    function test_gas_router_completeDeposit() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1 ether, _leaves(3, 4));
        vm.deal(ethRouter.depositBoxOf(i), 1 ether);
        TacitEvmPoolRouter.Tx memory t = _txRoot(ethPool, 202, 0, 0, _leaves(3, 4), address(0), 1 ether, keeper, 0.001 ether);
        vm.prank(keeper);
        ethRouter.completeDeposit(i, t);
        _record("router_completeDeposit");
    }

    function _receiveTx(uint256 amount, uint256 fee) internal view returns (TacitEvmPoolRouter.Tx memory) {
        address box = ethRouter.receiveBoxOf(NPK, 25);
        uint256 rho = uint256(keccak256(abi.encode(RECEIVE_TAG, box, ethRouter.receiveCount(box)))) % P;
        uint256 assetField = uint256(keccak256(abi.encode(block.chainid, address(ethPool), address(0)))) % P;
        uint256 leaf = IPoseidonT5(poseidon4).hash([assetField, amount - fee, NPK, rho]);
        return _tx(ethPool, 202, 0, _leaves(leaf, 0), address(0), int256(amount), keeper, fee, "", "");
    }

    function test_gas_router_sweepReceive_first() public {
        vm.deal(ethRouter.receiveBoxOf(NPK, 25), 1 ether);
        TacitEvmPoolRouter.Tx memory t = _receiveTx(1 ether, 0.0025 ether);
        vm.prank(keeper);
        ethRouter.sweepReceive(NPK, 25, t);
        _record("router_sweepReceive_first");
    }

    function test_gas_router_sweepReceive_repeat() public {
        address box = ethRouter.receiveBoxOf(NPK, 25);
        vm.deal(box, 1 ether);
        vm.prank(keeper);
        ethRouter.sweepReceive(NPK, 25, _receiveTx(1 ether, 0.0025 ether));
        if (box.code.length != 0) vm.skip(true); // needs --isolate
        vm.deal(box, 1 ether);
        TacitEvmPoolRouter.Tx memory t = _receiveTx(1 ether, 0.0025 ether);
        t.publicInputs[2] = 303;
        vm.prank(keeper);
        ethRouter.sweepReceive(NPK, 25, t);
        _record("router_sweepReceive_repeat");
    }

    function test_gas_router_withdrawToV1() public {
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(1 ether, 0.001 ether);
        TacitEvmPoolRouter.Tx memory t =
            _txRoot(ethPool, 202, 11, 12, _leaves(3, 0), ethRouter.wrapBoxOf(w), -1.001 ether, keeper, 0.001 ether);
        vm.prank(keeper);
        ethRouter.withdrawToV1(t, w);
        _record("router_withdrawToV1");
    }

    function test_gas_router_completeWrap() public {
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(1 ether, 0.001 ether);
        vm.deal(ethRouter.wrapBoxOf(w), 1.001 ether);
        vm.prank(keeper);
        ethRouter.completeWrap(w);
        _record("router_completeWrap");
    }

    function test_gas_router_depositWithPermit2() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(usdcPool, 202, 0, 0, _leaves(3, 4), address(0), 500, address(0), 0);
        IPermit2.PermitSingle memory ps = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({token: address(usdc), amount: 500, expiration: type(uint48).max, nonce: 0}),
            spender: address(usdcRouter),
            sigDeadline: block.timestamp + 1 hours
        });
        vm.prank(user);
        usdcRouter.depositWithPermit2(t, ps, "");
        _record("router_depositWithPermit2");
    }

    function test_gas_router_depositWithPermit2_repeat() public {
        IPermit2.PermitSingle memory ps = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({token: address(usdc), amount: 1000, expiration: type(uint48).max, nonce: 0}),
            spender: address(usdcRouter),
            sigDeadline: block.timestamp + 1 hours
        });
        TacitEvmPoolRouter.Tx memory t = _txRoot(usdcPool, 202, 0, 0, _leaves(3, 4), address(0), 500, address(0), 0);
        vm.prank(user);
        usdcRouter.depositWithPermit2(t, ps, "");
        t = _txRoot(usdcPool, 303, 0, 0, _leaves(5, 6), address(0), 500, address(0), 0);
        vm.prank(user);
        usdcRouter.depositWithPermit2(t, ps, "");
        _record("router_depositWithPermit2_repeat");
    }

    function test_gas_router_zapETHToDeposit() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(usdcPool, 202, 0, 0, _leaves(3, 4), address(0), 1000, address(0), 0);
        bytes memory swap = abi.encodeWithSelector(MockZRouter.swapETHForToken.selector, address(usdc), uint256(1030));
        vm.prank(user);
        usdcRouter.zapETHToDeposit{value: 0.1 ether}(t, swap);
        _record("router_zapETHToDeposit");
    }

    function test_gas_router_zapTokenToDeposit() public {
        TacitEvmPoolRouter.Tx memory t = _txRoot(ethPool, 202, 0, 0, _leaves(3, 4), address(0), 1 ether, address(0), 0);
        bytes memory swap = abi.encodeWithSelector(MockZRouterToEth.swapTokenForETH.selector, address(usdc), uint256(5000), uint256(1.2 ether));
        IPermit2.PermitSingle memory ps = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({token: address(usdc), amount: 6000, expiration: type(uint48).max, nonce: 0}),
            spender: address(ethRouter),
            sigDeadline: block.timestamp + 1 hours
        });
        vm.prank(user);
        ethRouter.zapTokenToDepositWithPermit2(t, 6000, ps, "", swap);
        _record("router_zapTokenToDeposit");
    }

    receive() external payable {}
}

/// The fixture's real proofs through the snarkjs verifier: what a user pays end to end.
contract TacitEvmPoolGasRealProofTest is GasRecorder {
    PoolToken token;
    TacitEvmPool pool;
    string json;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/evm_pool_transact.json"));
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        token = new PoolToken();
        TransactVerifierDev verifier = new TransactVerifierDev();
        pool = new TacitEvmPool(address(verifier), address(token));
        require(address(pool) == vm.parseJsonAddress(json, ".pool"), "fixture pool address");
        address depositor = vm.parseJsonAddress(json, ".depositor");
        token.mint(depositor, 1000);
        vm.prank(depositor);
        token.approve(address(pool), type(uint256).max);
    }

    function _send(uint256 i) internal {
        string memory k = string.concat(".steps[", vm.toString(i), "]");
        uint256[] memory a = vm.parseJsonUintArray(json, string.concat(k, ".pA"));
        uint256[] memory b0 = vm.parseJsonUintArray(json, string.concat(k, ".pB[0]"));
        uint256[] memory b1 = vm.parseJsonUintArray(json, string.concat(k, ".pB[1]"));
        uint256[] memory c = vm.parseJsonUintArray(json, string.concat(k, ".pC"));
        uint256[] memory p = vm.parseJsonUintArray(json, string.concat(k, ".publicInputs"));
        uint256[11] memory pub;
        for (uint256 j; j < 11; ++j) pub[j] = p[j];
        address recipient = vm.parseJsonAddress(json, string.concat(k, ".recipient"));
        int256 ext = vm.parseInt(vm.parseJsonString(json, string.concat(k, ".extAmount")));
        address relayer = vm.parseJsonAddress(json, string.concat(k, ".relayer"));
        uint256 fee = vm.parseUint(vm.parseJsonString(json, string.concat(k, ".fee")));
        bytes memory m0 = vm.parseJsonBytes(json, string.concat(k, ".memo0"));
        bytes memory m1 = vm.parseJsonBytes(json, string.concat(k, ".memo1"));
        if (i == 0) vm.prank(vm.parseJsonAddress(json, ".depositor"));
        pool.transact([a[0], a[1]], [[b0[0], b0[1]], [b1[0], b1[1]]], [c[0], c[1]], pub, recipient, ext, relayer, fee, m0, m1);
    }

    function test_gas_real_deposit_transfer_withdraw() public {
        _send(0);
        _record("real_proof_first_deposit");
        _send(1);
        _record("real_proof_transfer_relayed");
        _send(2);
        _record("real_proof_withdraw_relayed_no_change");
    }
}
