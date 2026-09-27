// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {IPoseidonT5} from "../src/TacitEvmPoolRouter.sol";
import {PoseidonT5Deploy} from "../script/PoseidonT5Deploy.sol";
import {AcceptTransact} from "./TacitEvmPool.t.sol";

/// Re-enters `target` with a stored payload the first time it is paid (ETH) or touched by a HookToken transfer.
/// The payload lives in transient storage so the attempt fits the pool's 100k ETH stipend; the outcome is read
/// back in the same transaction.
contract ReentryActor {
    function arm(address target, bytes calldata payload) external {
        assembly ("memory-safe") {
            tstore(0, target)
            tstore(1, payload.length)
            for { let i := 0 } lt(i, payload.length) { i := add(i, 32) } {
                tstore(add(2, div(i, 32)), calldataload(add(payload.offset, i)))
            }
            tstore(0x1000, 0)
            tstore(0x1001, 0)
            tstore(0x1002, 0)
        }
    }

    function result() external view returns (uint256 attempts, uint256 landed, bytes4 err) {
        assembly ("memory-safe") {
            attempts := tload(0x1000)
            landed := tload(0x1001)
            err := tload(0x1002)
        }
    }

    function _reenter() internal {
        assembly ("memory-safe") {
            let target := tload(0)
            if target {
                tstore(0, 0)
                let n := tload(1)
                let m := mload(0x40)
                for { let i := 0 } lt(i, n) { i := add(i, 32) } { mstore(add(m, i), tload(add(2, div(i, 32)))) }
                let ok := call(gas(), target, 0, m, n, 0, 0)
                tstore(0x1000, add(tload(0x1000), 1))
                switch ok
                case 1 { tstore(0x1001, add(tload(0x1001), 1)) }
                default {
                    if gt(returndatasize(), 3) {
                        returndatacopy(m, 0, 4)
                        tstore(0x1002, and(mload(m), shl(224, 0xffffffff)))
                    }
                }
            }
        }
    }

    function onToken() external {
        _reenter();
    }

    receive() external payable {
        _reenter();
    }
}

/// ERC-20 that calls `hook` before every balance change, like an ERC-777 send hook.
contract HookToken is ERC20 {
    address public hook;

    function name() public pure override returns (string memory) {
        return "Hook";
    }

    function symbol() public pure override returns (string memory) {
        return "HOOK";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address h) external {
        hook = h;
    }

    function _beforeTokenTransfer(address, address, uint256) internal override {
        if (hook != address(0)) ReentryActor(payable(hook)).onToken();
    }
}

/// Drives one pool with transactions an honest circuit would prove: Σ in + (ext − fee) = Σ out, every note below
/// 2^120, outputs inserted at nextIndex on the current root, inputs members of a root at or after their insertion,
/// nullifiers unique per note. Adversarial variants are sent alongside and must all revert.
contract PoolHandler is Test {
    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant MAX_NOTE = 1e24;

    struct Note {
        uint256 value;
        uint256 leaf;
        uint256 nf;
        uint256 rootIdx;
        bool spent;
    }

    struct T {
        uint256[11] pub;
        address recipient;
        int256 ext;
        address relayer;
        uint256 fee;
        bytes memo0;
        bytes memo1;
        uint256 value;
    }

    TacitEvmPool public pool;
    address public asset;
    IPoseidonT5 poseidon;
    ReentryActor public actor;
    uint256 assetField;

    Note[] public notes;
    bytes32[] public roots;
    uint256[] public dummyNfs;
    address[] public relayers;
    address[] public recipients;

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostFees;
    uint256 public ghostNoteSum;
    uint256 public ghostInserts;
    mapping(address => uint256) public ghostReceived;

    uint256 public violations;
    string public lastViolation;
    uint256 public reentryAttempts;
    uint256 public rejectedAsExpected;
    uint256 nonce;

    constructor(TacitEvmPool pool_, IPoseidonT5 poseidon_, ReentryActor actor_) {
        pool = pool_;
        asset = pool_.ASSET();
        poseidon = poseidon_;
        actor = actor_;
        assetField = uint256(keccak256(abi.encode(block.chainid, address(pool_), asset))) % P;
        roots.push(pool_.root());
        relayers.push(address(0xFEE1));
        relayers.push(address(0xFEE2));
        relayers.push(address(actor_));
        recipients.push(address(0xA11CE1));
        recipients.push(address(0xA11CE2));
        recipients.push(address(actor_));
        // ETH on both: the token pool's handler also sends ETH, which that pool must refuse.
        vm.deal(address(this), type(uint128).max);
        if (asset != address(0)) {
            HookToken(asset).mint(address(this), type(uint128).max);
            HookToken(asset).approve(address(pool_), type(uint256).max);
        }
    }

    // ──────────────────── views for the invariants ────────────────────

    function notesLength() external view returns (uint256) {
        return notes.length;
    }

    function rootsLength() external view returns (uint256) {
        return roots.length;
    }

    function dummyLength() external view returns (uint256) {
        return dummyNfs.length;
    }

    function relayersLength() external view returns (uint256) {
        return relayers.length;
    }

    function recipientsLength() external view returns (uint256) {
        return recipients.length;
    }

    // ──────────────────── honest transactions ────────────────────

    function deposit(uint256 amt, uint256 fee, uint256 split, uint8 flags, uint256 relSeed) external {
        amt = bound(amt, 1, MAX_NOTE);
        fee = flags & 4 != 0 ? bound(fee, 0, amt) : 0;
        _honest(type(uint256).max, type(uint256).max, flags & 8 != 0, int256(amt), fee, split, flags, address(0), relSeed, relSeed);
    }

    function transfer(uint256 a, uint256 b, uint256 fee, uint256 split, uint8 flags, uint256 relSeed, uint256 rootSeed) external {
        (uint256 i0, uint256 i1) = _pick(a, b, flags & 1 != 0);
        if (i0 == type(uint256).max) return;
        uint256 total = _in(i0) + _in(i1);
        fee = bound(fee, 0, total);
        _honest(i0, i1, flags & 8 != 0, 0, fee, split, flags, address(0), relSeed, rootSeed);
    }

    function withdraw(uint256 a, uint256 b, uint256 w, uint256 fee, uint256 split, uint8 flags, uint256 recSeed, uint256 relSeed)
        external
    {
        (uint256 i0, uint256 i1) = _pick(a, b, flags & 1 != 0);
        if (i0 == type(uint256).max) return;
        uint256 total = _in(i0) + _in(i1);
        if (total == 0) return;
        w = bound(w, 1, total);
        fee = bound(fee, 0, total - w);
        address r = recipients[recSeed % recipients.length];
        _honest(i0, i1, flags & 8 != 0, -int256(w), fee, split, flags, r, relSeed, relSeed);
    }

    /// Deposit and spend notes in the same call (ext > 0 with inputs).
    function topUp(uint256 a, uint256 amt, uint256 fee, uint256 split, uint8 flags, uint256 relSeed) external {
        (uint256 i0,) = _pick(a, 0, false);
        if (i0 == type(uint256).max) return;
        amt = bound(amt, 1, MAX_NOTE);
        fee = bound(fee, 0, amt + _in(i0));
        _honest(i0, type(uint256).max, false, int256(amt), fee, split, flags | 1, address(0), relSeed, relSeed);
    }

    function _in(uint256 i) internal view returns (uint256) {
        return i == type(uint256).max ? 0 : notes[i].value;
    }

    function _pick(uint256 a, uint256 b, bool two) internal view returns (uint256 i0, uint256 i1) {
        i0 = i1 = type(uint256).max;
        uint256 n = notes.length;
        if (n == 0) return (i0, i1);
        for (uint256 k; k < n; ++k) {
            uint256 j = (a + k) % n;
            if (!notes[j].spent) {
                i0 = j;
                break;
            }
        }
        if (!two || i0 == type(uint256).max) return (i0, i1);
        for (uint256 k; k < n; ++k) {
            uint256 j = (b + k) % n;
            if (!notes[j].spent && j != i0) {
                i1 = j;
                break;
            }
        }
    }

    /// Builds and sends a transaction the circuit accepts. `dummy` adds a zero-value input with a fresh nullifier
    /// (a non-empty slot with v = 0 skips membership). Output values split Σ in + ext − fee by `split`.
    function _honest(
        uint256 i0,
        uint256 i1,
        bool dummy,
        int256 ext,
        uint256 fee,
        uint256 split,
        uint8 flags,
        address recipient,
        uint256 relSeed,
        uint256 rootSeed
    ) internal {
        int256 outTotal = int256(_in(i0) + _in(i1)) + ext - int256(fee);
        require(outTotal >= 0, "handler: negative outputs");
        uint256 total = uint256(outTotal);
        uint256 v0 = total == 0 ? 0 : split % (total + 1);
        uint256 v1 = total - v0;
        bool fill0 = v0 != 0 || flags & 16 != 0;
        bool fill1 = v1 != 0 || flags & 32 != 0;

        T memory t;
        t.recipient = recipient;
        t.ext = ext;
        t.fee = fee;
        t.relayer = fee != 0 || flags & 64 != 0 ? relayers[relSeed % relayers.length] : address(0);
        if (flags & 128 != 0) {
            t.memo0 = abi.encodePacked(keccak256(abi.encode(nonce, "m0")));
            t.memo1 = hex"01";
        }
        t.value = asset == address(0) && ext > 0 ? uint256(ext) : 0;

        uint256 minRoot;
        if (i0 != type(uint256).max) minRoot = notes[i0].rootIdx;
        if (i1 != type(uint256).max && notes[i1].rootIdx > minRoot) minRoot = notes[i1].rootIdx;
        uint256 rootIdx = minRoot + rootSeed % (roots.length - minRoot);
        t.pub[0] = uint256(roots[rootIdx]);
        t.pub[1] = uint256(pool.root());
        t.pub[3] = pool.nextIndex();
        t.pub[6] = assetField;
        t.pub[7] = i0 != type(uint256).max ? notes[i0].nf : 0;
        t.pub[8] = i1 != type(uint256).max ? notes[i1].nf : 0;
        uint256 dnf;
        if (dummy) {
            dnf = _fresh("dummy");
            if (t.pub[7] == 0) t.pub[7] = dnf;
            else if (t.pub[8] == 0) t.pub[8] = dnf;
            else dnf = 0;
        }
        uint256 leaf0 = fill0 ? _leaf(v0) : 0;
        uint256 leaf1 = fill1 ? _leaf(v1) : 0;
        t.pub[9] = leaf0;
        t.pub[10] = leaf1;
        bool inserts = fill0 || fill1;
        uint256 newRoot = inserts ? _fresh("root") : t.pub[1];
        t.pub[2] = newRoot;
        _bind(t);

        bool arm = (recipient == address(actor) && ext < 0) || (t.relayer == address(actor) && fee != 0);
        if (arm) _armDoubleSpend(t);

        (bool ok, bytes memory ret) = _send(t);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        if (arm) _checkReentry();

        uint256 firstIndex = t.pub[3];
        if (i0 != type(uint256).max) {
            notes[i0].spent = true;
            ghostNoteSum -= notes[i0].value;
        }
        if (i1 != type(uint256).max) {
            notes[i1].spent = true;
            ghostNoteSum -= notes[i1].value;
        }
        if (dnf != 0) dummyNfs.push(dnf);
        if (inserts) {
            roots.push(bytes32(newRoot));
            ghostInserts++;
            if (fill0) _push(v0, leaf0, firstIndex);
            if (fill1) _push(v1, leaf1, firstIndex + 1);
        }
        if (ext > 0) ghostDeposited += uint256(ext);
        if (ext < 0) {
            ghostWithdrawn += uint256(-ext);
            ghostReceived[recipient] += uint256(-ext);
        }
        ghostFees += fee;
        ghostReceived[t.relayer] += fee;
    }

    function _push(uint256 v, uint256 leaf, uint256 index) internal {
        notes.push(Note(v, leaf, uint256(keccak256(abi.encode("nf", leaf, index))) % P, roots.length - 1, false));
        ghostNoteSum += v;
    }

    function _leaf(uint256 v) internal returns (uint256) {
        return poseidon.hash([assetField, v, _fresh("npk"), _fresh("rho")]);
    }

    function _fresh(string memory tag) internal returns (uint256 x) {
        x = uint256(keccak256(abi.encode(tag, ++nonce))) % P;
        if (x == 0) x = 1;
    }

    function _bind(T memory t) internal view {
        t.pub[4] = _pa(t.ext, t.fee);
        t.pub[5] = uint256(
            keccak256(abi.encode(block.chainid, address(pool), t.recipient, t.ext, t.relayer, t.fee, keccak256(t.memo0), keccak256(t.memo1)))
        ) % P;
    }

    function _pa(int256 ext, uint256 fee) internal pure returns (uint256) {
        int256 x = (ext - int256(fee)) % int256(P);
        return uint256(x < 0 ? x + int256(P) : x);
    }

    function _send(T memory t) internal returns (bool ok, bytes memory ret) {
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        (ok, ret) = address(pool).call{value: t.value}(
            abi.encodeCall(TacitEvmPool.transact, (z2, z22, z2, t.pub, t.recipient, t.ext, t.relayer, t.fee, t.memo0, t.memo1))
        );
    }

    /// While the outer call pays the actor, it tries to spend the outer call's first nullifier again through a
    /// no-output withdrawal of 1 to itself, built to pass every other check.
    function _armDoubleSpend(T memory outer) internal {
        uint256 nf = outer.pub[7] != 0 ? outer.pub[7] : outer.pub[8];
        if (nf == 0) nf = _fresh("unused");
        T memory r;
        r.recipient = address(actor);
        r.ext = -1;
        r.pub[0] = outer.pub[0];
        r.pub[6] = assetField;
        r.pub[7] = nf;
        _bind(r);
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        actor.arm(
            address(pool),
            abi.encodeCall(TacitEvmPool.transact, (z2, z22, z2, r.pub, r.recipient, r.ext, r.relayer, r.fee, r.memo0, r.memo1))
        );
        if (outer.pub[7] == 0 && outer.pub[8] == 0) actor.arm(address(0), "");
    }

    function _checkReentry() internal {
        (uint256 attempts, uint256 landed, bytes4 err) = actor.result();
        if (attempts == 0) return;
        reentryAttempts += attempts;
        if (landed != 0) _violate("reentrant double spend landed");
        else if (err != TacitEvmPool.AlreadyNullified.selector) _violate("reentrant double spend: unexpected rejection");
    }

    function _violate(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    function _expectReject(T memory t, bytes4 want, string memory why) internal {
        uint256 bal = _bal(address(pool));
        bytes32 root = pool.root();
        uint256 idx = pool.nextIndex();
        (bool ok, bytes memory ret) = _send(t);
        if (ok) return _violate(why);
        if (want != bytes4(0) && (ret.length < 4 || bytes4(ret) != want)) return _violate(string.concat(why, ": wrong error"));
        if (_bal(address(pool)) != bal || pool.root() != root || pool.nextIndex() != idx) return _violate(string.concat(why, ": state moved"));
        rejectedAsExpected++;
    }

    function _bal(address a) internal view returns (uint256) {
        return asset == address(0) ? a.balance : HookToken(asset).balanceOf(a);
    }

    // ──────────────────── adversarial transactions (must revert, change nothing) ────────────────────

    /// A withdrawal reusing a spent note's nullifier in either slot.
    function doubleSpend(uint256 seed, bool slot1) external {
        uint256 n = notes.length;
        for (uint256 k; k < n; ++k) {
            Note storage note = notes[(seed + k) % n];
            if (!note.spent) continue;
            T memory t;
            t.recipient = recipients[seed % 2];
            t.ext = -1;
            t.pub[0] = uint256(pool.root());
            t.pub[6] = assetField;
            t.pub[slot1 ? 8 : 7] = note.nf;
            _bind(t);
            return _expectReject(t, TacitEvmPool.AlreadyNullified.selector, "spent nullifier accepted");
        }
    }

    /// The same non-zero nullifier in both slots, as a transfer that would mint two change notes.
    function sameNullifierTwice(uint256 seed) external {
        uint256 nf = seed % P;
        if (nf == 0) nf = 1;
        T memory t;
        t.pub[0] = uint256(pool.root());
        t.pub[1] = uint256(pool.root());
        t.pub[2] = _fresh("root");
        t.pub[3] = pool.nextIndex();
        t.pub[6] = assetField;
        t.pub[7] = nf;
        t.pub[8] = nf;
        t.pub[9] = 1;
        _bind(t);
        _expectReject(t, TacitEvmPool.AlreadyNullified.selector, "duplicate nullifier pair accepted");
    }

    /// An inserting deposit built on a root or index other than the head.
    function staleInsert(uint256 seed, uint256 idxDelta, bool moveIndex) external {
        T memory t;
        t.ext = 1;
        t.value = asset == address(0) ? 1 : 0;
        t.pub[0] = uint256(pool.root());
        t.pub[1] = uint256(pool.root());
        t.pub[2] = _fresh("root");
        t.pub[3] = pool.nextIndex();
        t.pub[6] = assetField;
        t.pub[9] = _leaf(1);
        bytes4 want;
        if (moveIndex) {
            idxDelta = bound(idxDelta, 1, type(uint64).max);
            t.pub[3] = seed % 2 == 0 ? t.pub[3] + idxDelta : (t.pub[3] >= idxDelta ? t.pub[3] - idxDelta : t.pub[3] + idxDelta);
            want = TacitEvmPool.WrongInsertionIndex.selector;
        } else {
            uint256 old = roots.length > 1 ? uint256(roots[seed % (roots.length - 1)]) : uint256(keccak256(abi.encode(seed))) % P;
            if (old == t.pub[1]) old = t.pub[1] ^ 1;
            t.pub[1] = old;
            want = TacitEvmPool.StaleRoot.selector;
        }
        _bind(t);
        _expectReject(t, want, "stale insertion accepted");
    }

    /// An honest withdrawal from a live note with one bound field changed after binding.
    function tamper(uint256 a, uint8 field, uint256 noise) external {
        (uint256 i0,) = _pick(a, 0, false);
        if (i0 == type(uint256).max || notes[i0].value < 2) return;
        Note storage note = notes[i0];
        T memory t;
        t.recipient = recipients[a % 2];
        t.ext = -int256(note.value - 1);
        t.fee = 1;
        t.relayer = relayers[a % 2];
        t.memo0 = hex"aa";
        t.pub[0] = uint256(pool.root());
        t.pub[6] = assetField;
        t.pub[7] = note.nf;
        _bind(t);
        field = field % 11;
        if (field == 0) t.recipient = address(uint160(t.recipient) ^ uint160(bound(noise, 1, type(uint160).max)));
        else if (field == 1) t.ext = t.ext + 1;
        else if (field == 2) t.relayer = address(uint160(t.relayer) ^ uint160(bound(noise, 1, type(uint160).max)));
        else if (field == 3) t.fee = bound(noise, 0, 1) == 0 ? 0 : 2;
        else if (field == 4) t.memo0 = abi.encodePacked(t.memo0, bytes1(uint8(noise)));
        else if (field == 5) t.memo1 = abi.encodePacked(bytes1(uint8(noise)));
        else if (field == 6) (t.ext, t.fee) = (t.ext + 1, t.fee + 1); // same publicAmount
        else if (field == 7) t.pub[4] = addmod(t.pub[4], bound(noise, 1, P - 1), P);
        else if (field == 8) t.pub[5] = addmod(t.pub[5], bound(noise, 1, P - 1), P);
        else if (field == 9) t.pub[6] = addmod(t.pub[6], bound(noise, 1, P - 1), P);
        else {
            (t.memo0, t.memo1) = (t.memo1, t.memo0);
        }
        _expectReject(t, bytes4(0), "tampered field accepted");
    }

    /// ETH pool: msg.value other than the deposit amount. Token pool: any ETH at all.
    function wrongValue(uint256 amt, uint256 value) external {
        amt = bound(amt, 1, MAX_NOTE);
        T memory t;
        t.ext = int256(amt);
        t.pub[0] = uint256(pool.root());
        t.pub[1] = uint256(pool.root());
        t.pub[2] = _fresh("root");
        t.pub[3] = pool.nextIndex();
        t.pub[6] = assetField;
        t.pub[9] = _leaf(amt);
        _bind(t);
        if (asset == address(0)) {
            t.value = bound(value, 0, 2 * MAX_NOTE);
            if (t.value == amt) t.value = amt + 1;
            _expectReject(t, TacitEvmPool.EthValueMismatch.selector, "ETH mismatch accepted");
        } else {
            t.value = bound(value, 1, MAX_NOTE);
            _expectReject(t, TacitEvmPool.EthNotAccepted.selector, "token pool took ETH");
        }
    }

    /// |ext| or fee at or above 2^120.
    function outOfRange(uint256 mag, bool neg, bool onFee) external {
        mag = bound(mag, 1 << 120, uint256(type(int256).max));
        T memory t;
        if (onFee) t.fee = mag;
        else t.ext = neg ? -int256(mag) : int256(mag);
        t.recipient = recipients[0];
        t.relayer = relayers[0];
        t.pub[0] = uint256(pool.root());
        t.pub[6] = assetField;
        t.pub[7] = _fresh("oor");
        t.pub[4] = 0;
        t.pub[5] = uint256(keccak256(abi.encode(block.chainid, address(pool), t.recipient, t.ext, t.relayer, t.fee, keccak256(""), keccak256("")))) % P;
        _expectReject(t, TacitEvmPool.ValueOutOfRange.selector, "out-of-range value accepted");
    }

    function unknownRoot(uint256 r) external {
        if (pool.everKnownRoot(bytes32(r))) return;
        T memory t;
        t.recipient = recipients[0];
        t.ext = -1;
        t.pub[0] = r;
        t.pub[6] = assetField;
        t.pub[7] = _fresh("ukr");
        _bind(t);
        _expectReject(t, TacitEvmPool.UnknownMembershipRoot.selector, "unknown membership root accepted");
    }

    receive() external payable {}
}

abstract contract PoolInvariantBase is Test {
    TacitEvmPool pool;
    PoolHandler handler;
    ReentryActor actor;

    function _setUp(address asset) internal {
        vm.chainId(1);
        IPoseidonT5 poseidon = IPoseidonT5(PoseidonT5Deploy.ensure());
        pool = new TacitEvmPool(address(new AcceptTransact()), asset);
        actor = new ReentryActor();
        if (asset != address(0)) HookToken(asset).setHook(address(actor));
        handler = new PoolHandler(pool, poseidon, actor);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](11);
        sel[0] = PoolHandler.deposit.selector;
        sel[1] = PoolHandler.transfer.selector;
        sel[2] = PoolHandler.withdraw.selector;
        sel[3] = PoolHandler.topUp.selector;
        sel[4] = PoolHandler.doubleSpend.selector;
        sel[5] = PoolHandler.sameNullifierTwice.selector;
        sel[6] = PoolHandler.staleInsert.selector;
        sel[7] = PoolHandler.tamper.selector;
        sel[8] = PoolHandler.wrongValue.selector;
        sel[9] = PoolHandler.outOfRange.selector;
        sel[10] = PoolHandler.unknownRoot.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _bal(address a) internal view returns (uint256) {
        address asset = pool.ASSET();
        return asset == address(0) ? a.balance : HookToken(asset).balanceOf(a);
    }

    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_solvency() public view {
        uint256 bal = _bal(address(pool));
        assertEq(bal, handler.ghostDeposited() - handler.ghostWithdrawn() - handler.ghostFees(), "balance = in - out - fees");
        assertEq(bal, handler.ghostNoteSum(), "balance = unspent note value");
    }

    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_payoutsOnlyToNamedParties() public view {
        for (uint256 i; i < handler.relayersLength(); ++i) {
            address r = handler.relayers(i);
            assertEq(_bal(r), handler.ghostReceived(r), "relayer paid exactly its fees");
        }
        for (uint256 i; i < handler.recipientsLength(); ++i) {
            address r = handler.recipients(i);
            assertEq(_bal(r), handler.ghostReceived(r), "recipient paid exactly its withdrawals");
        }
        assertEq(_bal(address(0)), 0, "nothing paid to the zero address");
    }

    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_tree() public view {
        uint256 n = handler.rootsLength();
        assertEq(pool.nextIndex(), 2 * handler.ghostInserts(), "nextIndex counts inserted pairs");
        assertEq(pool.nextIndex() % 2, 0, "nextIndex even");
        assertEq(pool.root(), handler.roots(n - 1), "root is the last inserted root");
        for (uint256 i; i < n; ++i) assertTrue(pool.everKnownRoot(handler.roots(i)), "every held root stays known");
    }

    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_nullifiers() public view {
        assertFalse(pool.nullified(bytes32(0)), "zero nullifier never recorded");
        for (uint256 i; i < handler.notesLength(); ++i) {
            (,, uint256 nf,, bool spent) = handler.notes(i);
            assertEq(pool.nullified(bytes32(nf)), spent, "nullified iff spent");
        }
        for (uint256 i; i < handler.dummyLength(); ++i) assertTrue(pool.nullified(bytes32(handler.dummyNfs(i))));
    }

    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 32
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_adversarialCallsAllRejected() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
    }
}

contract TacitEvmPoolEthInvariantTest is PoolInvariantBase {
    function setUp() public {
        _setUp(address(0));
    }
}

contract TacitEvmPoolTokenInvariantTest is PoolInvariantBase {
    function setUp() public {
        _setUp(address(new HookToken()));
    }
}
