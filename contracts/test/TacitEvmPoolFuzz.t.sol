// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {AcceptTransact, PoolToken} from "./TacitEvmPool.t.sol";
import {ReentryActor, HookToken} from "./TacitEvmPoolInvariant.t.sol";

contract PoolHarness is TacitEvmPool {
    constructor(address v, address a) TacitEvmPool(v, a) {}

    function publicAmount(int256 ext, uint256 fee) external pure returns (uint256) {
        return _publicAmount(ext, fee);
    }
}

/// Transfers `amount − skim` and burns `skim` from the sender, or mints `-skim` extra when negative.
contract SkimToken is ERC20 {
    int256 public skim;

    function name() public pure override returns (string memory) {
        return "Skim";
    }

    function symbol() public pure override returns (string memory) {
        return "SKM";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setSkim(int256 s) external {
        skim = s;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        if (skim >= 0) {
            _transfer(from, to, amount - uint256(skim));
            _burn(from, uint256(skim));
        } else {
            _transfer(from, to, amount);
            _mint(to, uint256(-skim));
        }
        return true;
    }
}

/// On a HookToken transfer, sends one stored pool call from itself (it holds tokens and approved the pool).
contract NestedCaller {
    address target;
    bytes payload;
    bool armed;
    bool public landed;
    bytes public err;

    function arm(address t, bytes calldata p) external {
        (target, payload, armed) = (t, p, true);
    }

    function approve(address token, address spender) external {
        ERC20(token).approve(spender, type(uint256).max);
    }

    function onToken() external {
        if (!armed) return;
        armed = false;
        bool ok;
        (ok, err) = target.call(payload);
        landed = ok;
    }
}

/// Stateless fuzzing of each rule TacitEvmPool enforces itself, with an accept-all verifier.
contract TacitEvmPoolFuzzTest is Test {
    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant VMAX = 1 << 120;
    address constant RECIPIENT = address(0xC0FFEE);
    address constant RELAYER = address(0xFEE);

    struct T {
        uint256[11] pub;
        address recipient;
        int256 ext;
        address relayer;
        uint256 fee;
        bytes memo0;
        bytes memo1;
    }

    AcceptTransact verifier;
    PoolHarness ethPool;
    PoolHarness otherEthPool;
    TacitEvmPool tokenPool;
    PoolToken token;

    function setUp() public {
        vm.chainId(1);
        verifier = new AcceptTransact();
        ethPool = new PoolHarness(address(verifier), address(0));
        otherEthPool = new PoolHarness(address(verifier), address(0));
        token = new PoolToken();
        tokenPool = new TacitEvmPool(address(verifier), address(token));
        vm.deal(address(this), type(uint128).max);
    }

    function _field(TacitEvmPool pool) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(pool), pool.ASSET()))) % P;
    }

    function _pa(int256 ext, uint256 fee) internal pure returns (uint256) {
        return ext >= int256(fee) ? uint256(ext - int256(fee)) : P - uint256(int256(fee) - ext);
    }

    function _extHash(TacitEvmPool pool, T memory t) internal view returns (uint256) {
        return uint256(
            keccak256(abi.encode(block.chainid, address(pool), t.recipient, t.ext, t.relayer, t.fee, keccak256(t.memo0), keccak256(t.memo1)))
        ) % P;
    }

    function _bind(TacitEvmPool pool, T memory t) internal view {
        t.pub[4] = _pa(t.ext, t.fee);
        t.pub[5] = _extHash(pool, t);
    }

    /// A withdrawal of `amount` with `fee` spending nullifier `nf`, no outputs, bound to `pool`.
    function _withdrawal(TacitEvmPool pool, uint256 nf, uint256 amount, uint256 fee) internal view returns (T memory t) {
        t.recipient = RECIPIENT;
        t.ext = -int256(amount);
        t.relayer = RELAYER;
        t.fee = fee;
        t.memo0 = hex"1234";
        t.memo1 = hex"5678";
        t.pub[0] = uint256(pool.root());
        t.pub[6] = _field(pool);
        t.pub[7] = nf;
        _bind(pool, t);
    }

    /// An inserting deposit of `amount` on the pool's head.
    function _depositTx(TacitEvmPool pool, uint256 amount, uint256 newRoot) internal view returns (T memory t) {
        t.ext = int256(amount);
        t.pub[0] = uint256(pool.root());
        t.pub[1] = uint256(pool.root());
        t.pub[2] = newRoot;
        t.pub[3] = pool.nextIndex();
        t.pub[6] = _field(pool);
        t.pub[9] = 1;
        _bind(pool, t);
    }

    function _send(TacitEvmPool pool, T memory t, uint256 value) internal returns (bool ok, bytes memory ret) {
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        (ok, ret) = address(pool).call{value: value}(
            abi.encodeCall(TacitEvmPool.transact, (z2, z22, z2, t.pub, t.recipient, t.ext, t.relayer, t.fee, t.memo0, t.memo1))
        );
    }

    function _expect(TacitEvmPool pool, T memory t, uint256 value, bytes4 err) internal {
        bytes32 root = pool.root();
        uint256 idx = pool.nextIndex();
        uint256 bal = address(pool).balance;
        (bool ok, bytes memory ret) = _send(pool, t, value);
        assertFalse(ok, "must revert");
        assertEq(bytes4(ret), err, "revert reason");
        assertEq(pool.root(), root);
        assertEq(pool.nextIndex(), idx);
        assertEq(address(pool).balance, bal);
    }

    function _ok(TacitEvmPool pool, T memory t, uint256 value) internal {
        (bool ok, bytes memory ret) = _send(pool, t, value);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _fund(TacitEvmPool pool, uint256 amount) internal {
        _ok(pool, _depositTx(pool, amount, 777), amount);
    }

    // ──────────────────── extDataHash / publicAmount binding ────────────────────

    /// Each field of the external data, changed after binding, is caught by the contract even when publicAmount is
    /// recomputed to match, so the extDataHash check alone rejects it.
    function testFuzz_extDataHash_binds_every_field(uint8 field, uint256 noise, uint256 amount, uint256 fee) public {
        amount = bound(amount, 1, 1e24);
        fee = bound(fee, 0, 1e24);
        _fund(ethPool, amount + fee);
        T memory t = _withdrawal(ethPool, 42, amount, fee);

        uint256 snap = vm.snapshotState();
        _ok(ethPool, t, 0);
        assertEq(RECIPIENT.balance, amount);
        vm.revertToState(snap);

        TacitEvmPool target = ethPool;
        field = field % 8;
        if (field == 0) {
            t.recipient = address(uint160(bound(noise, 1, type(uint160).max)));
            if (t.recipient == RECIPIENT) t.recipient = address(0xBEEF);
        } else if (field == 1) {
            int256 e = -int256(bound(noise, 1, amount + fee));
            t.ext = e == t.ext ? e + 1 : e;
            if (t.ext == 0) t.ext = -2;
            t.pub[4] = _pa(t.ext, t.fee);
        } else if (field == 2) {
            t.relayer = address(uint160(bound(noise, 1, type(uint160).max)));
            if (t.relayer == RELAYER) t.relayer = address(0xBEEF);
        } else if (field == 3) {
            uint256 f = bound(noise, 0, amount);
            t.fee = f == fee ? f + 1 : f;
            t.pub[4] = _pa(t.ext, t.fee);
        } else if (field == 4) {
            t.memo0 = abi.encodePacked(t.memo0, noise);
        } else if (field == 5) {
            t.memo1 = abi.encodePacked(noise);
        } else if (field == 6) {
            uint256 id = bound(noise, 2, type(uint64).max);
            vm.chainId(id);
        } else {
            _fund(otherEthPool, amount + fee);
            t.pub[0] = uint256(otherEthPool.root());
            t.pub[6] = _field(otherEthPool);
            target = otherEthPool;
        }
        _expect(target, t, 0, TacitEvmPool.BadProof.selector);
    }

    /// publicAmount must be exactly (ext − fee) mod p: any other field element is rejected.
    function testFuzz_publicAmount_mismatch_rejected(uint256 delta, uint256 amount, uint256 fee) public {
        amount = bound(amount, 1, 1e24);
        fee = bound(fee, 0, 1e24);
        _fund(ethPool, amount + fee);
        T memory t = _withdrawal(ethPool, 42, amount, fee);
        t.pub[4] = addmod(t.pub[4], bound(delta, 1, P - 1), P);
        _expect(ethPool, t, 0, TacitEvmPool.BadProof.selector);
    }

    /// Over the whole accepted range, publicAmount is (ext − fee) mod p with no wrap into the other half: a
    /// non-negative difference stays below 2^120 and a negative one sits within 2^121 below p, so Σ in + publicAmount
    /// = Σ out over notes below 2^120 has exactly the integer meaning.
    function testFuzz_publicAmount_no_wrap(int256 ext, uint256 fee) public view {
        ext = bound(ext, -int256(VMAX) + 1, int256(VMAX) - 1);
        fee = bound(fee, 0, VMAX - 1);
        uint256 pa = ethPool.publicAmount(ext, fee);
        assertEq(pa, _pa(ext, fee));
        assertLt(pa, P);
        if (ext >= int256(fee)) assertLt(pa, VMAX);
        else assertGt(pa, P - 2 * VMAX);
    }

    function testFuzz_publicAmount_injective(int256 e1, uint256 f1, int256 e2, uint256 f2) public view {
        e1 = bound(e1, -int256(VMAX) + 1, int256(VMAX) - 1);
        e2 = bound(e2, -int256(VMAX) + 1, int256(VMAX) - 1);
        f1 = bound(f1, 0, VMAX - 1);
        f2 = bound(f2, 0, VMAX - 1);
        if (e1 - int256(f1) == e2 - int256(f2)) return;
        assertTrue(ethPool.publicAmount(e1, f1) != ethPool.publicAmount(e2, f2));
    }

    /// Every in-range (ext, fee) settles exactly: recipient gets −ext, relayer fee, the pool moves by ext − fee.
    function testFuzz_settlement_exact(int256 ext, uint256 fee) public {
        ext = bound(ext, -int256(VMAX) + 1, int256(VMAX) - 1);
        fee = bound(fee, 0, VMAX - 1);
        vm.deal(address(ethPool), 4 * VMAX);
        T memory t;
        t.recipient = RECIPIENT;
        t.ext = ext;
        t.relayer = RELAYER;
        t.fee = fee;
        t.pub[0] = uint256(ethPool.root());
        t.pub[6] = _field(ethPool);
        t.pub[7] = 5;
        _bind(ethPool, t);
        uint256 before = address(ethPool).balance;
        _ok(ethPool, t, ext > 0 ? uint256(ext) : 0);
        assertEq(int256(address(ethPool).balance) - int256(before), ext - int256(fee));
        assertEq(RECIPIENT.balance, ext < 0 ? uint256(-ext) : 0);
        assertEq(RELAYER.balance, fee);
    }

    // ──────────────────── value bounds ────────────────────

    function testFuzz_value_bounds(int256 ext, uint256 fee) public {
        bool oor = ext <= -int256(VMAX) || ext >= int256(VMAX) || fee >= VMAX;
        if (ext == type(int256).min) ext = type(int256).min + 1;
        T memory t;
        t.recipient = RECIPIENT;
        t.ext = ext;
        t.relayer = RELAYER;
        t.fee = fee;
        t.pub[0] = uint256(ethPool.root());
        t.pub[6] = _field(ethPool);
        t.pub[7] = 5;
        t.pub[5] = _extHash(ethPool, t);
        if (!oor) t.pub[4] = _pa(ext, fee);
        vm.deal(address(ethPool), 4 * VMAX);
        (bool ok, bytes memory ret) = _send(ethPool, t, ext > 0 && ext < int256(VMAX) ? uint256(ext) : 0);
        if (oor) {
            assertFalse(ok);
            assertEq(bytes4(ret), TacitEvmPool.ValueOutOfRange.selector);
        } else {
            assertTrue(ok, "in-range value settles");
        }
    }

    // ──────────────────── ETH handling ────────────────────

    function testFuzz_eth_value_must_equal_inflow(int256 ext, uint256 value) public {
        ext = bound(ext, -1e24, 1e24);
        uint256 inflow = ext > 0 ? uint256(ext) : 0;
        value = bound(value, 0, 2e24);
        if (value == inflow) value = inflow + 1;
        vm.deal(address(ethPool), 1e25);
        T memory t = _withdrawal(ethPool, 9, 0, 0);
        t.ext = ext;
        _bind(ethPool, t);
        _expect(ethPool, t, value, TacitEvmPool.EthValueMismatch.selector);
        assertFalse(ethPool.nullified(bytes32(uint256(9))));
    }

    function testFuzz_token_pool_refuses_eth(int256 ext, uint256 value) public {
        ext = bound(ext, -1e24, 1e24);
        value = bound(value, 1, 1e24);
        token.mint(address(this), 1e24);
        token.approve(address(tokenPool), type(uint256).max);
        token.mint(address(tokenPool), 1e24);
        T memory t = _withdrawal(tokenPool, 9, 0, 0);
        t.ext = ext;
        _bind(tokenPool, t);
        (bool ok, bytes memory ret) = _send(tokenPool, t, value);
        assertFalse(ok);
        assertEq(bytes4(ret), TacitEvmPool.EthNotAccepted.selector);
    }

    /// A token that delivers anything other than exactly the deposit amount (short or long) is rejected.
    function testFuzz_non_exact_transfer_token_rejected(uint256 amount, int256 skim) public {
        amount = bound(amount, 2, 1e24);
        skim = bound(skim, -1e24, int256(amount) - 1);
        if (skim == 0) skim = 1;
        SkimToken st = new SkimToken();
        TacitEvmPool p = new TacitEvmPool(address(verifier), address(st));
        st.mint(address(this), 2e24);
        st.approve(address(p), type(uint256).max);
        st.setSkim(skim);
        T memory t = _depositTx(p, amount, 777);
        (bool ok, bytes memory ret) = _send(p, t, 0);
        assertFalse(ok);
        assertEq(bytes4(ret), TacitEvmPool.FeeOnTransferAsset.selector);
        assertEq(p.nextIndex(), 0);
    }

    // ──────────────────── tree position ────────────────────

    function testFuzz_stale_old_root_rejected(uint256 bad, uint256 amount) public {
        amount = bound(amount, 1, 1e24);
        _fund(ethPool, amount);
        T memory t = _depositTx(ethPool, amount, 888);
        if (bytes32(bad) == ethPool.root()) bad ^= 1;
        t.pub[1] = bad;
        _expect(ethPool, t, amount, TacitEvmPool.StaleRoot.selector);
    }

    function testFuzz_wrong_start_index_rejected(uint256 bad, uint256 amount) public {
        amount = bound(amount, 1, 1e24);
        _fund(ethPool, amount);
        T memory t = _depositTx(ethPool, amount, 888);
        if (bad == ethPool.nextIndex()) bad++;
        t.pub[3] = bad;
        _expect(ethPool, t, amount, TacitEvmPool.WrongInsertionIndex.selector);
    }

    /// Either output leaf alone makes the call inserting; both roots and the index are then checked.
    function testFuzz_single_output_inserts(uint256 leaf, bool second, uint256 newRoot) public {
        leaf = bound(leaf, 1, P - 1);
        T memory t = _depositTx(ethPool, 1 ether, newRoot);
        t.pub[9] = second ? 0 : leaf;
        t.pub[10] = second ? leaf : 0;
        _ok(ethPool, t, 1 ether);
        assertEq(ethPool.nextIndex(), 2);
        assertEq(ethPool.root(), bytes32(newRoot));
        assertTrue(ethPool.everKnownRoot(bytes32(newRoot)));
    }

    /// With both outputs empty the tree fields are ignored and nothing moves.
    function testFuzz_no_output_call_moves_nothing(uint256 oldRoot, uint256 newRoot, uint256 idx, uint256 amount) public {
        amount = bound(amount, 1, 1e24);
        _fund(ethPool, amount);
        bytes32 root = ethPool.root();
        bool known = ethPool.everKnownRoot(bytes32(newRoot));
        T memory t = _withdrawal(ethPool, 42, amount, 0);
        t.pub[1] = oldRoot;
        t.pub[2] = newRoot;
        t.pub[3] = idx;
        _ok(ethPool, t, 0);
        assertEq(ethPool.root(), root);
        assertEq(ethPool.nextIndex(), 2);
        assertEq(ethPool.everKnownRoot(bytes32(newRoot)), known);
    }

    function testFuzz_unknown_membership_root(uint256 r) public {
        _fund(ethPool, 1);
        vm.assume(!ethPool.everKnownRoot(bytes32(r)));
        T memory t = _withdrawal(ethPool, 42, 1, 0);
        t.pub[0] = r;
        _expect(ethPool, t, 0, TacitEvmPool.UnknownMembershipRoot.selector);
    }

    function testFuzz_wrong_asset_field(uint256 f) public {
        vm.assume(f != _field(ethPool));
        _fund(ethPool, 1);
        T memory t = _withdrawal(ethPool, 42, 1, 0);
        t.pub[6] = f;
        _expect(ethPool, t, 0, TacitEvmPool.WrongAsset.selector);
    }

    // ──────────────────── nullifiers ────────────────────

    function testFuzz_equal_nonzero_nullifiers_rejected(uint256 nf) public {
        nf = bound(nf, 1, type(uint256).max);
        _fund(ethPool, 1);
        T memory t = _withdrawal(ethPool, nf, 1, 0);
        t.pub[8] = nf;
        _expect(ethPool, t, 0, TacitEvmPool.AlreadyNullified.selector);
        assertFalse(ethPool.nullified(bytes32(nf)));
    }

    function testFuzz_nullifier_spent_once(uint256 nf, bool slot) public {
        nf = bound(nf, 1, type(uint256).max);
        _fund(ethPool, 2);
        _ok(ethPool, _withdrawal(ethPool, nf, 1, 0), 0);
        assertTrue(ethPool.nullified(bytes32(nf)));
        T memory t = _withdrawal(ethPool, 0, 1, 0);
        t.pub[slot ? 8 : 7] = nf;
        t.pub[slot ? 7 : 8] = slot ? 7 : 0;
        _expect(ethPool, t, 0, TacitEvmPool.AlreadyNullified.selector);
    }

    function testFuzz_zero_nullifier_never_recorded(uint256 nf1) public {
        _fund(ethPool, 1);
        T memory t = _withdrawal(ethPool, 0, 1, 0);
        t.pub[8] = nf1;
        _ok(ethPool, t, 0);
        assertFalse(ethPool.nullified(bytes32(0)));
        assertEq(ethPool.nullified(bytes32(nf1)), nf1 != 0);
        T memory again = _withdrawal(ethPool, 0, 0, 0);
        again.ext = 0;
        again.recipient = address(0);
        _bind(ethPool, again);
        _ok(ethPool, again, 0);
    }

    // ──────────────────── reentrancy ────────────────────

    /// The recipient and the relayer of a withdrawal each try to spend its nullifier again from their ETH callback.
    function testFuzz_eth_payee_reentry_cannot_double_spend(uint256 amount, uint256 fee, bool asRelayer) public {
        amount = bound(amount, 1, 1e24);
        fee = bound(fee, 1, 1e24);
        _fund(ethPool, 2 * (amount + fee));
        ReentryActor actor = new ReentryActor();
        T memory t = _withdrawal(ethPool, 42, amount, fee);
        if (asRelayer) t.relayer = address(actor);
        else t.recipient = address(actor);
        _bind(ethPool, t);
        T memory again = _withdrawal(ethPool, 42, amount, fee);
        again.recipient = address(actor);
        _bind(ethPool, again);
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        actor.arm(
            address(ethPool),
            abi.encodeCall(TacitEvmPool.transact, (z2, z22, z2, again.pub, again.recipient, again.ext, again.relayer, again.fee, again.memo0, again.memo1))
        );
        uint256 before = address(ethPool).balance;
        _ok(ethPool, t, 0);
        (uint256 attempts, uint256 landed, bytes4 err) = actor.result();
        assertEq(attempts, 1);
        assertEq(landed, 0);
        assertEq(err, TacitEvmPool.AlreadyNullified.selector);
        assertEq(before - address(ethPool).balance, amount + fee);
    }

    /// A token hook that deposits into the pool while the pool is measuring an outer deposit makes the outer
    /// deposit revert as a non-exact transfer: nothing is credited twice.
    function test_hook_nested_deposit_during_deposit_reverts_outer() public {
        HookToken ht = new HookToken();
        TacitEvmPool p = new TacitEvmPool(address(verifier), address(ht));
        NestedCaller nc = new NestedCaller();
        ht.mint(address(this), 1000);
        ht.mint(address(nc), 1000);
        ht.approve(address(p), type(uint256).max);
        nc.approve(address(ht), address(p));
        ht.setHook(address(nc));

        T memory outer = _depositTx(p, 100, 11);
        // Built on the head the outer call has already written when its transferFrom runs.
        T memory inner = _depositTx(p, 50, 22);
        inner.pub[1] = 11;
        inner.pub[3] = 2;
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        nc.arm(address(p), abi.encodeCall(TacitEvmPool.transact, (z2, z22, z2, inner.pub, inner.recipient, inner.ext, inner.relayer, inner.fee, inner.memo0, inner.memo1)));
        (bool ok, bytes memory ret) = _send(p, outer, 0);
        assertFalse(ok);
        assertEq(bytes4(ret), TacitEvmPool.FeeOnTransferAsset.selector);
        assertEq(ht.balanceOf(address(p)), 0);
        assertEq(p.nextIndex(), 0);
    }

    /// A hook-driven deposit nested in a withdrawal's payout lands as its own transaction; the pool's balance still
    /// equals what it owes (outer: −100, inner: +50 on top of the funded 100).
    function test_hook_nested_deposit_during_withdrawal_stays_consistent() public {
        HookToken ht = new HookToken();
        TacitEvmPool p = new TacitEvmPool(address(verifier), address(ht));
        NestedCaller nc = new NestedCaller();
        ht.mint(address(this), 1000);
        ht.mint(address(nc), 1000);
        ht.approve(address(p), type(uint256).max);
        nc.approve(address(ht), address(p));
        _ok(p, _depositTx(p, 100, 11), 0);
        ht.setHook(address(nc));

        T memory outer = _withdrawal(p, 42, 100, 0);
        // The inner deposit is built on the head the pool will hold once the outer call has run: the outer
        // call inserts nothing, so the head is unchanged.
        T memory inner = _depositTx(p, 50, 22);
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        nc.arm(address(p), abi.encodeCall(TacitEvmPool.transact, (z2, z22, z2, inner.pub, inner.recipient, inner.ext, inner.relayer, inner.fee, inner.memo0, inner.memo1)));
        _ok(p, outer, 0);
        assertTrue(nc.landed());
        assertEq(ht.balanceOf(address(p)), 50);
        assertEq(ht.balanceOf(RECIPIENT), 100);
        assertEq(p.nextIndex(), 4);
    }

    receive() external payable {}
}
