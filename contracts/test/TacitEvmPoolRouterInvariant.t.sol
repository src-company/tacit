// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter, IPoseidonT5} from "../src/TacitEvmPoolRouter.sol";
import {PoseidonT5Deploy} from "../script/PoseidonT5Deploy.sol";
import {AcceptTransact, PoolToken} from "./TacitEvmPool.t.sol";
import {TxBuilder} from "./TacitEvmPoolRouter.t.sol";
import {MockZRouter} from "./ConfidentialRouter.t.sol";
import {ReentryActor, HookToken} from "./TacitEvmPoolInvariant.t.sol";

/// The two V1 calls a wrap box makes: an asset registry of one entry, and a wrap that takes exactly `amount`.
contract MockV1Wrap {
    bytes32 public constant ID = keccak256("mock-v1-asset");
    address public immutable underlying;

    constructor(address underlying_) {
        underlying = underlying_;
    }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        return (id == ID, underlying, 1, bytes32(0), false, 18);
    }

    function wrap(bytes32, uint256 amount, bytes32) external payable {
        if (underlying == address(0)) require(msg.value == amount, "value");
        else SafeTransferLib.safeTransferFrom(underlying, msg.sender, address(this), amount);
    }
}

/// Drives one router over receive, deposit and wrap boxes and pool → V1 withdrawals with transactions an honest
/// circuit accepts, and tracks where every unit of the pool asset put into a box ends up.
contract RouterHandler is TxBuilder {
    bytes32 constant RECEIVE_TAG = keccak256("tacit-evm-pool-receive-box-v1");
    address constant KEEPER = address(0x4EE9E5);
    address constant REFUND = address(0x5AFE);
    address constant TIPTO = address(0x7199);
    uint256 constant MAX = 1e24;

    TacitEvmPoolRouter public router;
    TacitEvmPool public pool;
    address public asset;
    IPoseidonT5 poseidon;
    MockV1Wrap public v1;
    uint256 assetField;

    uint256[2] npks = [uint256(0x1234567890abcdef), uint256(P - 1)];
    uint16[3] bpss = [uint16(0), 30, 10_000];

    TacitEvmPoolRouter.DepositIntent[] dIntents;
    TacitEvmPoolRouter.WrapIntent[] wIntents;
    address[] public boxes;
    mapping(address => bool) isBox;

    mapping(address => uint256) public ghostBox;
    mapping(address => uint256) public ghostSweeps;
    uint256 public ghostIn;
    uint256 public ghostPool;
    uint256 public ghostKeeper;
    uint256 public ghostRefund;
    uint256 public ghostTip;
    uint256 public ghostV1;
    uint256 public ghostInserts;

    uint256 public violations;
    string public lastViolation;
    uint256 nonce;

    constructor(TacitEvmPoolRouter router_, IPoseidonT5 poseidon_, MockV1Wrap v1_) {
        router = router_;
        pool = TacitEvmPool(address(router_.POOL()));
        asset = pool.ASSET();
        poseidon = poseidon_;
        v1 = v1_;
        assetField = uint256(keccak256(abi.encode(block.chainid, address(pool), asset))) % P;
        for (uint256 i; i < 2; ++i) {
            for (uint256 j; j < 3; ++j) _track(router_.receiveBoxOf(npks[i], bpss[j]));
        }
        vm.deal(address(this), type(uint128).max);
    }

    function boxesLength() external view returns (uint256) {
        return boxes.length;
    }

    function _track(address box) internal {
        if (!isBox[box]) {
            isBox[box] = true;
            boxes.push(box);
        }
    }

    function _bal(address a) internal view returns (uint256) {
        return asset == address(0) ? a.balance : PoolToken(asset).balanceOf(a);
    }

    function _pay(address to, uint256 amt) internal {
        if (asset == address(0)) SafeTransferLib.safeTransferETH(to, amt);
        else PoolToken(asset).mint(to, amt);
        ghostIn += amt;
        ghostBox[to] += amt;
    }

    function _fresh() internal returns (uint256 x) {
        x = uint256(keccak256(abi.encode("r", ++nonce))) % P;
        if (x == 0) x = 1;
    }

    function _violate(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    function _bubble(bool ok, bytes memory ret) internal pure {
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    // ──────────────────── receive boxes ────────────────────

    function payReceive(uint256 i, uint256 amt) external {
        amt = bound(amt, 1, MAX);
        _pay(boxes[i % 6], amt);
    }

    /// ETH to a token pool's receive box (or nothing on an ETH pool): an asset the box never releases.
    function strayEthToReceive(uint256 i, uint256 amt) external {
        if (asset == address(0)) return;
        amt = bound(amt, 1, 1 ether);
        SafeTransferLib.safeTransferETH(boxes[i % 6], amt);
    }

    function _receiveTx(uint256 npk, address box, uint256 amount, uint256 fee, uint256 value)
        internal
        returns (TacitEvmPoolRouter.Tx memory t)
    {
        uint256 rho = uint256(keccak256(abi.encode(RECEIVE_TAG, box, router.receiveCount(box)))) % P;
        uint256 leaf = poseidon.hash([assetField, value, npk, rho]);
        t = _tx(pool, _fresh(), 0, _leaves(leaf, 0), address(0), int256(amount), KEEPER, fee, "", "");
    }

    function sweep(uint256 i, uint256 feeSeed) external {
        i = i % 6;
        uint256 npk = npks[i / 3];
        uint16 bps = bpss[i % 3];
        address box = boxes[i];
        uint256 amount = _bal(box);
        if (amount == 0) return;
        uint256 fee = bound(feeSeed, 0, amount * bps / 10_000);
        TacitEvmPoolRouter.Tx memory t = _receiveTx(npk, box, amount, fee, amount - fee);
        uint256 strayEth = asset == address(0) ? 0 : box.balance;
        uint256 idx = pool.nextIndex();
        (bool ok, bytes memory ret) = address(router).call(abi.encodeCall(TacitEvmPoolRouter.sweepReceive, (npk, bps, t)));
        _bubble(ok, ret);
        ghostBox[box] -= amount;
        ghostPool += amount - fee;
        ghostKeeper += fee;
        ghostSweeps[box]++;
        ghostInserts++;
        if (_bal(box) != 0) _violate("receive box not emptied");
        if (asset != address(0) && box.balance != strayEth) _violate("stray ETH left a token receive box");
        if (pool.nextIndex() != idx + 2) _violate("sweep did not insert one pair");
    }

    /// A sweep that takes more than the box's fee cap, credits another key or value, or leaves part of the
    /// balance behind.
    function badSweep(uint256 i, uint8 mode, uint256 noise) external {
        i = i % 6;
        uint256 npk = npks[i / 3];
        uint16 bps = bpss[i % 3];
        address box = boxes[i];
        uint256 amount = _bal(box);
        if (amount < 2) return;
        TacitEvmPoolRouter.Tx memory t;
        mode = mode % 4;
        if (mode == 0) {
            uint256 cap = amount * bps / 10_000;
            if (cap >= amount) return;
            uint256 fee = bound(noise, cap + 1, amount);
            t = _receiveTx(npk, box, amount, fee, amount - fee);
        } else if (mode == 1) {
            t = _receiveTx(npks[(i / 3 + 1) % 2], box, amount, 0, amount);
        } else if (mode == 2) {
            uint256 v = bound(noise, 0, amount + MAX);
            if (v == amount) v = amount + 1;
            t = _receiveTx(npk, box, amount, 0, v);
        } else {
            uint256 part = bound(noise, 1, amount - 1);
            t = _receiveTx(npk, box, part, 0, part);
        }
        (bool ok,) = address(router).call(abi.encodeCall(TacitEvmPoolRouter.sweepReceive, (npk, bps, t)));
        if (ok) _violate("bad sweep accepted");
    }

    // ──────────────────── deposit boxes ────────────────────

    function newDepositIntent(uint256 amt, uint256 fund) external {
        TacitEvmPoolRouter.DepositIntent memory d;
        d.amount = bound(amt, 1, MAX);
        d.outLeaf0 = _fresh();
        d.outLeaf1 = nonce % 2 == 0 ? _fresh() : 0;
        d.memo0Hash = keccak256("m0");
        d.memo1Hash = keccak256("");
        d.refund = REFUND;
        d.deadline = uint64(block.timestamp + 1 days);
        d.nonce = ++nonce;
        dIntents.push(d);
        address box = router.depositBoxOf(d);
        _track(box);
        fund = bound(fund, 0, 2 * d.amount);
        if (fund != 0) _pay(box, fund);
    }

    function fundDeposit(uint256 k, uint256 amt) external {
        if (dIntents.length == 0) return;
        _pay(router.depositBoxOf(dIntents[k % dIntents.length]), bound(amt, 1, MAX));
    }

    function completeDeposit(uint256 k, uint256 feeSeed) external {
        if (dIntents.length == 0) return;
        TacitEvmPoolRouter.DepositIntent memory d = dIntents[k % dIntents.length];
        address box = router.depositBoxOf(d);
        uint256 fee = bound(feeSeed, 0, d.amount);
        TacitEvmPoolRouter.Tx memory t =
            _tx(pool, _fresh(), 0, _leaves(d.outLeaf0, d.outLeaf1), address(0), int256(d.amount), KEEPER, fee, "m0", "");
        uint256 held = _bal(box);
        (bool ok, bytes memory ret) = address(router).call(abi.encodeCall(TacitEvmPoolRouter.completeDeposit, (d, t)));
        if (held < d.amount) {
            if (ok) _violate("underfunded deposit box completed");
            return;
        }
        _bubble(ok, ret);
        ghostBox[box] -= d.amount;
        ghostPool += d.amount - fee;
        ghostKeeper += fee;
        ghostInserts++;
    }

    function reclaimDeposit(uint256 k, bool early) external {
        if (dIntents.length == 0) return;
        TacitEvmPoolRouter.DepositIntent memory d = dIntents[k % dIntents.length];
        _reclaim(router.depositBoxOf(d), d.deadline, early, abi.encodeCall(TacitEvmPoolRouter.reclaimDeposit, (d, asset)));
    }

    function _reclaim(address box, uint64 deadline, bool early, bytes memory data) internal {
        if (early && block.timestamp <= deadline) {
            (bool ok0,) = address(router).call(data);
            if (ok0) _violate("reclaim before deadline");
            return;
        }
        if (block.timestamp <= deadline) vm.warp(uint256(deadline) + 1);
        uint256 bal = _bal(box);
        (bool ok, bytes memory ret) = address(router).call(data);
        if (bal == 0) {
            if (ok) _violate("empty reclaim succeeded");
            return;
        }
        _bubble(ok, ret);
        ghostBox[box] -= bal;
        ghostRefund += bal;
    }

    // ──────────────────── wrap boxes and pool → V1 ────────────────────

    function newWrapIntent(uint256 amt, uint256 tip, bool openTip, uint256 fund) external {
        TacitEvmPoolRouter.WrapIntent memory w;
        w.assetId = v1.ID();
        w.amount = bound(amt, 1, MAX);
        w.tip = bound(tip, 0, w.amount);
        w.tipTo = openTip ? address(0) : TIPTO;
        w.commit = bytes32(_fresh());
        w.refund = REFUND;
        w.deadline = uint64(block.timestamp + 1 days);
        w.nonce = ++nonce;
        wIntents.push(w);
        address box = router.wrapBoxOf(w);
        _track(box);
        fund = bound(fund, 0, 2 * (w.amount + w.tip));
        if (fund != 0) _pay(box, fund);
    }

    function completeWrap(uint256 k) external {
        if (wIntents.length == 0) return;
        TacitEvmPoolRouter.WrapIntent memory w = wIntents[k % wIntents.length];
        address box = router.wrapBoxOf(w);
        uint256 held = _bal(box);
        vm.prank(KEEPER);
        (bool ok, bytes memory ret) = address(router).call(abi.encodeCall(TacitEvmPoolRouter.completeWrap, (w)));
        if (held < w.amount + w.tip) {
            if (ok) _violate("underfunded wrap box completed");
            return;
        }
        _bubble(ok, ret);
        _wrapped(box, w);
    }

    function _wrapped(address box, TacitEvmPoolRouter.WrapIntent memory w) internal {
        ghostBox[box] -= w.amount + w.tip;
        ghostV1 += w.amount;
        if (w.tipTo == address(0)) ghostKeeper += w.tip;
        else ghostTip += w.tip;
    }

    function reclaimWrap(uint256 k, bool early) external {
        if (wIntents.length == 0) return;
        TacitEvmPoolRouter.WrapIntent memory w = wIntents[k % wIntents.length];
        _reclaim(router.wrapBoxOf(w), w.deadline, early, abi.encodeCall(TacitEvmPoolRouter.reclaimWrap, (w, asset)));
    }

    /// Withdraw from the pool's router-credited balance straight into a wrap box and complete it.
    function withdrawToV1(uint256 k, uint256 feeSeed) external {
        if (wIntents.length == 0) return;
        TacitEvmPoolRouter.WrapIntent memory w = wIntents[k % wIntents.length];
        address box = router.wrapBoxOf(w);
        uint256 need = w.amount + w.tip;
        uint256 held = _bal(box);
        uint256 out = held >= need ? 1 : need - held;
        if (ghostPool < out) return;
        uint256 fee = bound(feeSeed, 0, ghostPool - out);
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 0, _fresh(), _noLeaves(), box, -int256(out), KEEPER, fee, "", "");
        vm.prank(KEEPER);
        (bool ok, bytes memory ret) = address(router).call(abi.encodeCall(TacitEvmPoolRouter.withdrawToV1, (t, w)));
        _bubble(ok, ret);
        ghostPool -= out + fee;
        ghostKeeper += fee;
        ghostBox[box] += out;
        _wrapped(box, w);
    }

    receive() external payable {}
}

abstract contract RouterInvariantBase is Test {
    TacitEvmPool pool;
    TacitEvmPoolRouter router;
    RouterHandler handler;
    MockV1Wrap v1;
    address asset;

    function _setUp(address asset_) internal {
        vm.chainId(1);
        asset = asset_;
        IPoseidonT5 poseidon = IPoseidonT5(PoseidonT5Deploy.ensure());
        pool = new TacitEvmPool(address(new AcceptTransact()), asset_);
        v1 = new MockV1Wrap(asset_);
        router = new TacitEvmPoolRouter(address(pool), address(new MockZRouter()), address(0), address(v1), address(poseidon));
        handler = new RouterHandler(router, poseidon, v1);
        targetContract(address(handler));
    }

    function _bal(address a) internal view returns (uint256) {
        return asset == address(0) ? a.balance : PoolToken(asset).balanceOf(a);
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_routerHoldsNothing() public view {
        assertEq(_bal(address(router)), 0, "router holds no pool asset");
        assertEq(address(router).balance, 0, "router holds no ETH");
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_everyUnitAccountedFor() public view {
        uint256 inBoxes;
        for (uint256 i; i < handler.boxesLength(); ++i) {
            address box = handler.boxes(i);
            assertEq(_bal(box), handler.ghostBox(box), "box holds exactly what it was paid less what it released");
            inBoxes += _bal(box);
        }
        assertEq(_bal(address(pool)), handler.ghostPool(), "pool");
        assertEq(_bal(address(0x4EE9E5)), handler.ghostKeeper(), "keeper: fees and open tips");
        assertEq(_bal(address(0x5AFE)), handler.ghostRefund(), "refund: reclaims only");
        assertEq(_bal(address(0x7199)), handler.ghostTip(), "tipTo");
        assertEq(_bal(address(v1)), handler.ghostV1(), "V1: wraps only");
        assertEq(
            handler.ghostIn(),
            inBoxes + handler.ghostPool() + handler.ghostKeeper() + handler.ghostRefund() + handler.ghostTip() + handler.ghostV1(),
            "conservation"
        );
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_receiveCountsAndTree() public view {
        for (uint256 i; i < 6; ++i) {
            address box = handler.boxes(i);
            assertEq(router.receiveCount(box), handler.ghostSweeps(box), "receiveCount = sweeps");
        }
        assertEq(pool.nextIndex(), 2 * handler.ghostInserts(), "one pair per completion");
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_badCallsRejected() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
    }
}

contract TacitEvmPoolRouterEthInvariantTest is RouterInvariantBase {
    function setUp() public {
        _setUp(address(0));
    }
}

contract TacitEvmPoolRouterTokenInvariantTest is RouterInvariantBase {
    function setUp() public {
        _setUp(address(new PoolToken()));
    }
}

/// Stateless router properties: exact receive credit, reentrancy, and the stray-ETH finding.
contract TacitEvmPoolRouterFuzzTest is TxBuilder {
    bytes32 constant RECEIVE_TAG = keccak256("tacit-evm-pool-receive-box-v1");
    address constant KEEPER = address(0x4EE9E5);

    TacitEvmPool ethPool;
    TacitEvmPoolRouter ethRouter;
    TacitEvmPool tokenPool;
    TacitEvmPoolRouter tokenRouter;
    PoolToken token;
    IPoseidonT5 poseidon;
    MockZRouter zr;

    function setUp() public {
        vm.chainId(1);
        poseidon = IPoseidonT5(PoseidonT5Deploy.ensure());
        address v = address(new AcceptTransact());
        zr = new MockZRouter();
        ethPool = new TacitEvmPool(v, address(0));
        ethRouter = new TacitEvmPoolRouter(address(ethPool), address(0), address(0), address(0), address(poseidon));
        token = new PoolToken();
        tokenPool = new TacitEvmPool(v, address(token));
        tokenRouter = new TacitEvmPoolRouter(address(tokenPool), address(zr), address(0), address(0), address(poseidon));
    }

    function _receiveTx(TacitEvmPool p, TacitEvmPoolRouter r, uint256 npk, uint16 bps, uint256 amount, uint256 fee, uint256 newRoot)
        internal
        view
        returns (TacitEvmPoolRouter.Tx memory)
    {
        address box = r.receiveBoxOf(npk, bps);
        uint256 rho = uint256(keccak256(abi.encode(RECEIVE_TAG, box, r.receiveCount(box)))) % P;
        uint256 f = uint256(keccak256(abi.encode(block.chainid, address(p), p.ASSET()))) % P;
        uint256 leaf = poseidon.hash([f, amount - fee, npk, rho]);
        return _tx(p, newRoot, 0, _leaves(leaf, 0), address(0), int256(amount), KEEPER, fee, "", "");
    }

    /// A sweep succeeds iff fee ≤ feeBps of the balance, and then credits exactly Poseidon(asset, amount − fee,
    /// npk, rho_n), pays the fee to the named relayer, empties the box and bumps the counter by one.
    function testFuzz_receive_sweep_exact_credit(uint256 npk, uint16 bps, uint256 amount, uint256 fee) public {
        npk = bound(npk, 0, P - 1);
        bps = uint16(bound(bps, 0, 10_000));
        amount = bound(amount, 1, 1e24);
        fee = bound(fee, 0, amount);
        address box = ethRouter.receiveBoxOf(npk, bps);
        vm.deal(box, amount);
        TacitEvmPoolRouter.Tx memory t = _receiveTx(ethPool, ethRouter, npk, bps, amount, fee, 11);
        bool allowed = fee * 10_000 <= amount * bps;
        if (!allowed) vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        ethRouter.sweepReceive(npk, bps, t);
        if (!allowed) return;
        assertEq(address(ethPool).balance, amount - fee);
        assertEq(KEEPER.balance, fee);
        assertEq(box.balance, 0);
        assertEq(address(ethRouter).balance, 0);
        assertEq(ethRouter.receiveCount(box), 1);
        assertEq(ethPool.nextIndex(), 2);
    }

    /// Any leaf other than the router's own computation is rejected.
    function testFuzz_receive_sweep_rejects_other_leaves(uint256 leaf, uint256 amount) public {
        amount = bound(amount, 1, 1e24);
        uint256 npk = 0xABC;
        address box = ethRouter.receiveBoxOf(npk, 0);
        vm.deal(box, amount);
        TacitEvmPoolRouter.Tx memory t = _receiveTx(ethPool, ethRouter, npk, 0, amount, 0, 11);
        vm.assume(leaf != t.publicInputs[9]);
        t.publicInputs[9] = leaf;
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        ethRouter.sweepReceive(npk, 0, t);
    }

    /// Under --isolate the sweep's transaction ends before the checks, so the box's code is gone; the address still
    /// takes a plain payment and the next sweep re-creates it with the next rho.
    function testFuzz_receive_box_codeless_after_sweep_isolated(uint256 a1, uint256 a2) public {
        a1 = bound(a1, 1, 1e24);
        a2 = bound(a2, 1, 1e24);
        uint256 npk = 0xABC;
        address box = ethRouter.receiveBoxOf(npk, 0);
        vm.deal(address(this), a1 + a2);
        SafeTransferLib.safeTransferETH(box, a1);
        ethRouter.sweepReceive(npk, 0, _receiveTx(ethPool, ethRouter, npk, 0, a1, 0, 11));
        if (box.code.length != 0) vm.skip(true);
        assertEq(box.balance, 0);
        (bool ok,) = payable(box).call{value: a2, gas: 2300}("");
        assertTrue(ok);
        ethRouter.sweepReceive(npk, 0, _receiveTx(ethPool, ethRouter, npk, 0, a2, 0, 22));
        assertEq(box.code.length, 0);
        assertEq(ethRouter.receiveCount(box), 2);
        assertEq(address(ethPool).balance, a1 + a2);
    }

    /// The pool pays an ETH relayer inside sweepReceive; the relayer re-enters the router with a sweep that is
    /// otherwise valid (built on the head the outer call leaves). Only the guard stops it, and it is valid after.
    function testFuzz_relayer_reentry_blocked(uint256 amount, uint256 fee) public {
        amount = bound(amount, 2, 1e24);
        fee = bound(fee, 1, amount);
        ReentryActor actor = new ReentryActor();
        uint256 npk = 0xABC;
        address box = ethRouter.receiveBoxOf(npk, 10_000);
        address box2 = ethRouter.receiveBoxOf(npk + 1, 0);
        vm.deal(box, amount);
        vm.deal(box2, amount);
        TacitEvmPoolRouter.Tx memory t = _receiveTx(ethPool, ethRouter, npk, 10_000, amount, fee, 11);
        t.relayer = address(actor);
        t.publicInputs[5] = uint256(keccak256(abi.encode(block.chainid, address(ethPool), address(0), t.extAmount, address(actor), fee, keccak256(""), keccak256("")))) % P;
        TacitEvmPoolRouter.Tx memory inner = _receiveTx(ethPool, ethRouter, npk + 1, 0, amount, 0, 22);
        inner.publicInputs[1] = 11;
        inner.publicInputs[3] = 2;
        actor.arm(address(ethRouter), abi.encodeCall(TacitEvmPoolRouter.sweepReceive, (npk + 1, uint16(0), inner)));
        ethRouter.sweepReceive(npk, 10_000, t);
        (uint256 attempts, uint256 landed, bytes4 err) = actor.result();
        assertEq(attempts, 1);
        assertEq(landed, 0);
        assertEq(err, ReentrancyGuardTransient.Reentrancy.selector);
        assertEq(address(actor).balance, fee);
        ethRouter.sweepReceive(npk + 1, 0, inner);
        assertEq(address(ethPool).balance, 2 * amount - fee);
        assertEq(address(ethRouter).balance, 0);
    }

    /// A token hook re-entering the router while the pool pulls a box's deposit from it is stopped by the guard.
    function test_token_hook_reentry_blocked() public {
        HookToken ht = new HookToken();
        TacitEvmPool p = new TacitEvmPool(address(new AcceptTransact()), address(ht));
        TacitEvmPoolRouter r = new TacitEvmPoolRouter(address(p), address(0), address(0), address(0), address(poseidon));
        ReentryActor actor = new ReentryActor();
        uint256 npk = 0xABC;
        ht.mint(r.receiveBoxOf(npk, 0), 100);
        ht.mint(r.receiveBoxOf(npk + 1, 0), 100);
        ht.setHook(address(actor));
        TacitEvmPoolRouter.Tx memory inner = _receiveTx(p, r, npk + 1, 0, 100, 0, 22);
        actor.arm(address(r), abi.encodeCall(TacitEvmPoolRouter.sweepReceive, (npk + 1, uint16(0), inner)));
        r.sweepReceive(npk, 0, _receiveTx(p, r, npk, 0, 100, 0, 11));
        (uint256 attempts, uint256 landed, bytes4 err) = actor.result();
        assertEq(attempts, 1);
        assertEq(landed, 0);
        assertEq(err, ReentrancyGuardTransient.Reentrancy.selector);
        assertEq(ht.balanceOf(address(p)), 100);
        assertEq(ht.balanceOf(address(r)), 0);
    }

    /// A reclaim refund recipient re-entering to complete another box is stopped by the guard.
    function test_refund_reentry_blocked() public {
        ReentryActor actor = new ReentryActor();
        TacitEvmPoolRouter.DepositIntent memory d;
        d.amount = 1 ether;
        d.outLeaf0 = 5;
        d.memo0Hash = keccak256("");
        d.memo1Hash = keccak256("");
        d.refund = address(actor);
        d.deadline = uint64(block.timestamp + 1);
        TacitEvmPoolRouter.DepositIntent memory d2 = abi.decode(abi.encode(d), (TacitEvmPoolRouter.DepositIntent));
        d2.nonce = 2;
        vm.deal(ethRouter.depositBoxOf(d), 1 ether);
        vm.deal(ethRouter.depositBoxOf(d2), 1 ether);
        TacitEvmPoolRouter.Tx memory t = _tx(ethPool, 11, 0, _leaves(5, 0), address(0), 1 ether, address(0), 0, "", "");
        actor.arm(address(ethRouter), abi.encodeCall(TacitEvmPoolRouter.completeDeposit, (d2, t)));
        vm.warp(block.timestamp + 2);
        ethRouter.reclaimDeposit(d, address(0));
        (uint256 attempts, uint256 landed, bytes4 err) = actor.result();
        assertEq(attempts, 1);
        assertEq(landed, 0);
        assertEq(err, ReentrancyGuardTransient.Reentrancy.selector);
        assertEq(address(actor).balance, 1 ether);
        assertEq(ethRouter.depositBoxOf(d2).balance, 1 ether);
    }

    /// ETH sent to a token pool's receive box stays in the box through a sweep: the box is not closed, so the router
    /// never holds it and no caller can take it.
    function test_stray_receive_box_eth_stays_in_a_token_box() public {
        uint256 npk = 0xABC;
        address box = tokenRouter.receiveBoxOf(npk, 0);
        token.mint(box, 1000);
        vm.deal(address(this), 1 ether);
        SafeTransferLib.safeTransferETH(box, 1 ether);
        tokenRouter.sweepReceive(npk, 0, _receiveTx(tokenPool, tokenRouter, npk, 0, 1000, 0, 11));
        assertEq(box.balance, 1 ether);
        assertEq(address(tokenRouter).balance, 0);
        assertEq(token.balanceOf(box), 0);
    }

    receive() external payable {}
}
