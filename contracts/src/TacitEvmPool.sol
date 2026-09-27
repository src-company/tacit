// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice Groth16 verifier for dapp/circuits/evm-pool/transact.circom, exported by snarkjs. Public input order:
///         root, oldRoot, newRoot, startIndex, publicAmount, extDataHash, asset, nf[2], outLeaf[2].
interface ITransactVerifier {
    function verifyProof(uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC, uint256[11] calldata publicInputs)
        external
        view
        returns (bool);
}

/// @title TacitEvmPool
/// @notice A single-asset shielded pool proved on the user's device: fungible notes, private transfers with change,
///         and deposit/withdraw at the boundary, all through one Groth16 relation (dapp/circuits/evm-pool/transact.circom,
///         dapp/evm-pool-zk.js).
///
///         Immutable: no owner, no pause, no admin function. A different relation or verifier means a new pool at a
///         new address.
///
///         Notes live in an append-only Poseidon(2) tree of depth 32. A transact() with at least one output inserts
///         one pair of leaves (an empty slot of a non-empty pair is a zero leaf) at the pool's current size. The
///         insertion is proven in-circuit against `oldRoot`/`newRoot`, so the contract never hashes; the proof must
///         build on the current head, so submit through private order flow. A transact() whose outputs are both
///         empty inserts nothing and cannot go stale. Every root the pool has held is kept with the tree size it had
///         (`everKnownRoot`, `rootSize`), so inputs can be proven against a root that is no longer current.
contract TacitEvmPool {
    ITransactVerifier public immutable VERIFIER;
    /// @notice The pooled asset; address(0) is native ETH.
    address public immutable ASSET;
    /// @notice The circuit's `asset` public input: keccak256(abi.encode(chainid, pool, ASSET)) mod P.
    uint256 public immutable ASSET_FIELD;

    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    int256 internal constant P_INT = int256(P);
    uint256 internal constant VALUE_MAX = 1 << 120; // the circuit's value range

    /// @notice The current Merkle root.
    bytes32 public root;
    /// Tree size + 1 when each root was the head, 0 for a root the pool never held. The head's entry is the pool's size.
    mapping(bytes32 => uint256) internal _sizeOf;
    /// @notice Whether a nullifier has been spent.
    mapping(bytes32 => bool) public nullified;

    /// @notice One transact(). `firstIndex` is the tree position of `outLeaf0` (`outLeaf1` follows it); when both
    ///         leaves are zero nothing was inserted and `newRoot` is the unchanged head.
    event Transact(
        bytes32 indexed nf0,
        bytes32 indexed nf1,
        bytes32 outLeaf0,
        bytes32 outLeaf1,
        uint256 firstIndex,
        bytes32 newRoot,
        address recipient,
        int256 extAmount,
        address relayer,
        uint256 fee,
        bytes memo0,
        bytes memo1
    );

    error ZeroAddress();
    error NotAContract();
    error WrongAsset();
    error StaleRoot();
    error UnknownMembershipRoot();
    error WrongInsertionIndex();
    error PoolFull();
    error AlreadyNullified();
    error BadProof();
    error ValueOutOfRange();
    error EthValueMismatch();
    error EthNotAccepted();
    error FeeOnTransferAsset();

    constructor(address verifier_, address asset_) {
        if (verifier_ == address(0)) revert ZeroAddress();
        if (verifier_.code.length == 0) revert NotAContract();
        if (asset_ != address(0) && asset_.code.length == 0) revert NotAContract();
        VERIFIER = ITransactVerifier(verifier_);
        ASSET = asset_;
        ASSET_FIELD = uint256(keccak256(abi.encode(block.chainid, address(this), asset_))) % P;
        // Poseidon(0, 0), depth 32: the root of an all-empty tree.
        bytes32 empty = bytes32(uint256(21443572485391568159800782191812935835534334817699172242223315142338162256601));
        root = empty;
        _sizeOf[empty] = 1;
    }

    /// @notice The pool's leaf count (always even): where the next insertion starts.
    function nextIndex() public view returns (uint256) {
        return _sizeOf[root] - 1;
    }

    /// @notice The current root and leaf count: what an inserting proof is built against (`oldRoot`, `startIndex`).
    function head() external view returns (bytes32, uint256) {
        return (root, nextIndex());
    }

    /// @notice Whether `r` has ever been the pool's root: the roots a `root` public input may name.
    function everKnownRoot(bytes32 r) external view returns (bool) {
        return _sizeOf[r] != 0;
    }

    /// @notice The leaf count when `r` was the head; reverts for a root the pool never held.
    function rootSize(bytes32 r) external view returns (uint256) {
        uint256 s = _sizeOf[r];
        if (s == 0) revert UnknownMembershipRoot();
        return s - 1;
    }

    /// @notice `nullified` for each of `nfs`.
    function isSpent(bytes32[] calldata nfs) external view returns (bool[] memory spent) {
        spent = new bool[](nfs.length);
        for (uint256 i; i < nfs.length; ++i) {
            spent[i] = nullified[nfs[i]];
        }
    }

    /// @notice Deposit, private transfer and withdraw in one relation. `extAmount > 0` pulls that much ASSET from
    ///         msg.sender (for ETH, msg.value must equal it); `extAmount < 0` pays `-extAmount` to `recipient`;
    ///         `extAmount == 0` is an in-pool transfer. A non-zero `fee` is paid to `relayer` from the pool in the same
    ///         call, whatever the sign of `extAmount`. `recipient`, `extAmount`, `relayer`, `fee` and both memos are
    ///         bound by `extDataHash`, which the pool recomputes, so none can be changed after the owner signs.
    function transact(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[11] calldata publicInputs,
        address recipient,
        int256 extAmount,
        address relayer,
        uint256 fee,
        bytes calldata memo0,
        bytes calldata memo1
    ) external payable {
        if (publicInputs[6] != ASSET_FIELD) revert WrongAsset();
        bool inserts = publicInputs[9] != 0 || publicInputs[10] != 0;
        bytes32 head_ = root;
        uint256 firstIndex = _sizeOf[head_] - 1;
        if (inserts) {
            if (bytes32(publicInputs[1]) != head_) revert StaleRoot();
            if (publicInputs[3] != firstIndex) revert WrongInsertionIndex();
            if (firstIndex + 2 > (1 << 32)) revert PoolFull();
        }
        if (_sizeOf[bytes32(publicInputs[0])] == 0) revert UnknownMembershipRoot();
        if (extAmount <= -int256(VALUE_MAX) || extAmount >= int256(VALUE_MAX)) revert ValueOutOfRange();
        if (fee >= VALUE_MAX) revert ValueOutOfRange();
        if (fee != 0 && relayer == address(0)) revert ZeroAddress();
        if (extAmount < 0 && recipient == address(0)) revert ZeroAddress();

        bytes32 nf0 = bytes32(publicInputs[7]);
        bytes32 nf1 = bytes32(publicInputs[8]);
        if (nf0 != bytes32(0) && nullified[nf0]) revert AlreadyNullified();
        if (nf1 != bytes32(0) && nf1 == nf0) revert AlreadyNullified();
        if (nf1 != bytes32(0) && nullified[nf1]) revert AlreadyNullified();

        uint256 wantExtHash = uint256(
            keccak256(abi.encode(block.chainid, address(this), recipient, extAmount, relayer, fee, keccak256(memo0), keccak256(memo1)))
        ) % P;
        if (publicInputs[5] != wantExtHash) revert BadProof();
        if (publicInputs[4] != _publicAmount(extAmount, fee)) revert BadProof();

        if (!VERIFIER.verifyProof(pA, pB, pC, publicInputs)) revert BadProof();

        if (nf0 != bytes32(0)) nullified[nf0] = true;
        if (nf1 != bytes32(0)) nullified[nf1] = true;
        bytes32 newRoot = head_;
        if (inserts) {
            newRoot = bytes32(publicInputs[2]);
            root = newRoot;
            _sizeOf[newRoot] = firstIndex + 3;
        }

        _settle(recipient, extAmount, relayer, fee);

        emit Transact(
            nf0, nf1, bytes32(publicInputs[9]), bytes32(publicInputs[10]), firstIndex, newRoot,
            recipient, extAmount, relayer, fee, memo0, memo1
        );
    }

    function _publicAmount(int256 extAmount, uint256 fee) internal pure returns (uint256) {
        int256 pa = (extAmount - int256(fee)) % P_INT;
        if (pa < 0) pa += P_INT;
        return uint256(pa);
    }

    function _settle(address recipient, int256 extAmount, address relayer, uint256 fee) internal {
        if (ASSET == address(0)) {
            uint256 inflow = extAmount > 0 ? uint256(extAmount) : 0;
            if (msg.value != inflow) revert EthValueMismatch();
            if (extAmount < 0) SafeTransferLib.forceSafeTransferETH(recipient, uint256(-extAmount));
            if (fee != 0) SafeTransferLib.forceSafeTransferETH(relayer, fee);
        } else {
            if (msg.value != 0) revert EthNotAccepted();
            if (extAmount > 0) {
                uint256 amount = uint256(extAmount);
                uint256 before = SafeTransferLib.balanceOf(ASSET, address(this));
                SafeTransferLib.safeTransferFrom(ASSET, msg.sender, address(this), amount);
                if (SafeTransferLib.balanceOf(ASSET, address(this)) - before != amount) revert FeeOnTransferAsset();
            } else if (extAmount < 0) {
                SafeTransferLib.safeTransfer(ASSET, recipient, uint256(-extAmount));
            }
            if (fee != 0) SafeTransferLib.safeTransfer(ASSET, relayer, fee);
        }
    }
}
