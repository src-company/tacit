// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EIP712} from "solady/utils/EIP712.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface ISettlePool {
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
}

interface ITac {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function balanceOf(address) external view returns (uint256);
}

/// @title ProofMarket — pay in TAC for an entry op to be proved and settled, only if the pool accepts it
/// @notice A holder who wants a public/entry op (a wrap, a zap's share, a voucher: anything that carries no secret and
///         that anyone may settle) done fast signs an INTENT: the op's id (the keccak of its public values, which the
///         client knows before any proof exists), the most TAC they will pay, and how the price rises from a floor to
///         that most over time. A prover `claim`s the op (a small ETH bond; the price is fixed at that moment and the
///         op is theirs alone for CLAIM_WINDOW seconds), then `fulfill`s it: in ONE transaction the pool settles the
///         proof and the prover is paid the claimed price in TAC, pulled from the payer, and gets the bond back. If the
///         pool refuses the proof the whole call reverts, so TAC moves only when the pool has accepted exactly the op
///         the payer signed for. A claim that lapses forfeits its bond to TREASURY, so holding an op without
///         delivering it costs money.
/// @dev    TWO WAYS TO AUTHORISE. Direct: the payer signs the intent (`tank` = 0) and a TAC permit for that op's most.
///         Tank (a "proof tank"): the payer signs ONE package, a `Tank` naming a delegate key (the page's session
///         key), a total `cap`, a per-op `perOpMax` and an expiry, plus one permit for `cap`; the delegate then signs
///         each op's intent, which names the tank it draws on. The contract counts what each tank has paid and never
///         pulls past `cap`. A tank is bounded by its cap, per-op limit and expiry; it does not check that the proved op
///         is a useful one, so a leaked delegate key can spend the tank on junk ops up to the cap: keep caps modest and
///         revoke on any doubt. The payer can `revokeTank`, `cancel` an op (not while it is claimed), or set the
///         allowance to 0.
///
///         WHAT THIS DOES NOT GUARANTEE. There is no escrow: TAC is pulled at `fulfill`, so a payer who moves the TAC,
///         withdraws the allowance, burns the permit nonce or revokes the tank after the proof is made makes the
///         `fulfill` revert, and the prover has spent its proving for nothing (a claim checks the payer holds the price
///         and a tank has the room, which narrows but does not close this). And `ConfidentialPool.settle` is
///         permissionless: anyone who sees the proof in the public mempool can settle the op directly and skip the
///         market. Provers therefore claim in an earlier block, simulate, and submit `fulfill` privately. The market
///         guarantees only the converse: the payer is never charged more than signed, nothing is charged unless the
///         pool accepted exactly the signed op, and a copied proof cannot take the fee through the market.
///
///         Non-custodial apart from claim bonds: TAC goes payer -> prover directly; the market holds only the bonds
///         of live claims. The settle runs with msg.sender == this contract, so a native-ETH fee leg is passed on to
///         the prover (a bonus on top of the price, signed inside the op's public values), and a fee in any other asset
///         would strand: provers build such proofs fee-free (the router's wrapAndSettle* rule).
///         A wallet permit suits public ops only: on a private op it would link the wallet to the op, so those keep
///         their fee inside the pool. Note `permit` SETS the allowance: a later permit overwrites an earlier one.
contract ProofMarket is EIP712 {
    struct Intent {
        address payer; // pays the TAC (signs this intent, or has named a delegate in a tank)
        bytes32 opId; // keccak256(publicValues): the one op this pays for
        uint256 floorFee; // price at `start`, in TAC base units
        uint256 maxFee; // price from `start + rampSecs` on
        uint64 start; // when the price begins to rise
        uint64 rampSecs; // seconds from floor to max (0: always max)
        uint64 deadline; // after this nothing is claimed or fulfilled
        bytes32 tank; // 0 for a direct intent; else the hash of the tank it draws on
    }

    struct Tank {
        address payer; // whose TAC it is; signs the tank and the permit
        address delegate; // the key that may sign intents against this tank (the page's session key)
        uint256 cap; // the most this tank ever pays out in total; also the permit's value
        uint256 perOpMax; // no single op may be priced above this
        uint64 expiry; // after this the tank pays nothing (and is the permit's deadline)
        uint256 salt; // lets one payer sign several tanks
    }

    struct Claim {
        address solver;
        uint64 until;
        uint256 price;
        uint256 bond;
        bytes32 intentHash; // the intent this claim is for: a claim cannot be used under another intent
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address payer,bytes32 opId,uint256 floorFee,uint256 maxFee,uint64 start,uint64 rampSecs,uint64 deadline,bytes32 tank)"
    );
    bytes32 public constant TANK_TYPEHASH =
        keccak256("Tank(address payer,address delegate,uint256 cap,uint256 perOpMax,uint64 expiry,uint256 salt)");

    address public immutable POOL;
    address public immutable TAC;
    /// How long a claim excludes everyone else, seconds.
    uint64 public immutable CLAIM_WINDOW;
    /// The ETH a claim puts up (exactly this): back to the prover on fulfil, to TREASURY if the claim lapses.
    uint256 public immutable CLAIM_BOND;
    address public immutable TREASURY;

    mapping(bytes32 opId => Claim) public claims;
    mapping(bytes32 opId => bool) public done;
    mapping(address payer => mapping(bytes32 opId => bool)) public cancelled;
    mapping(bytes32 tankId => uint256) public spent;
    mapping(bytes32 tankId => bool) public tankRevoked;

    error BadConfig();
    error BadSignature();
    error Expired();
    error Cancelled();
    error AlreadyDone();
    error WrongOp();
    error Claimed();
    error NoClaim();
    error BadPrice();
    error BadBond();
    error Unfunded();
    error WrongMode();
    error TankRevoked();
    error TankSpent();
    error NotPayer();

    event ClaimedOp(bytes32 indexed opId, address indexed solver, uint256 price, uint64 until);
    event Fulfilled(bytes32 indexed opId, address indexed payer, address indexed solver, uint256 price);
    event Lapsed(bytes32 indexed opId, address indexed solver, uint256 bond);
    event Cancel(address indexed payer, bytes32 indexed opId);
    event TankRevokedBy(address indexed payer, bytes32 indexed tankId);

    constructor(address pool, address tac, uint64 claimWindow, uint256 claimBond, address treasury) {
        if (
            pool == address(0) || pool.code.length == 0 || tac == address(0) || tac.code.length == 0 || claimWindow == 0
                || treasury == address(0)
        ) revert BadConfig();
        POOL = pool;
        TAC = tac;
        CLAIM_WINDOW = claimWindow;
        CLAIM_BOND = claimBond;
        TREASURY = treasury;
    }

    /// Lets `settle` pay this contract a native-ETH fee leg, which `fulfill` hands to the prover.
    receive() external payable {}

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("TacitProofMarket", "1");
    }

    /// The price at `ts`: the floor, rising in a straight line to the max over `rampSecs`.
    function priceAt(Intent calldata i, uint256 ts) public pure returns (uint256) {
        if (i.rampSecs == 0) return i.maxFee;
        if (ts <= i.start) return i.floorFee;
        uint256 el = ts - i.start;
        if (el >= i.rampSecs) return i.maxFee;
        return i.floorFee + ((i.maxFee - i.floorFee) * el) / i.rampSecs;
    }

    function intentHash(Intent calldata i) public view returns (bytes32) {
        return _hashTypedData(
            keccak256(
                abi.encode(INTENT_TYPEHASH, i.payer, i.opId, i.floorFee, i.maxFee, i.start, i.rampSecs, i.deadline, i.tank)
            )
        );
    }

    function tankHash(Tank calldata t) public view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(TANK_TYPEHASH, t.payer, t.delegate, t.cap, t.perOpMax, t.expiry, t.salt)));
    }

    /// The payer withdraws an intent. Not while the op is claimed: the prover is mid-delivery.
    function cancel(bytes32 opId) external {
        if (claims[opId].until > block.timestamp) revert Claimed();
        cancelled[msg.sender][opId] = true;
        emit Cancel(msg.sender, opId);
    }

    /// The payer withdraws a tank: it pays nothing more (what it already paid stays paid).
    function revokeTank(Tank calldata t) external {
        if (msg.sender != t.payer) revert NotPayer();
        bytes32 id = tankHash(t);
        tankRevoked[id] = true;
        emit TankRevokedBy(t.payer, id);
    }

    /// Takes the op at the price it has now, for CLAIM_WINDOW seconds, against a bond of exactly CLAIM_BOND ETH. Nobody
    /// else may claim or fulfill it meanwhile, so a watcher cannot copy the proof out of the mempool and take the fee
    /// (no proof is revealed by a claim). The payer must hold the price. A claim cannot be renewed while it is live.
    function claim(Intent calldata i, bytes calldata signature) external payable {
        _checkDirect(i, signature);
        _claim(i, type(uint256).max);
    }

    function claimFromTank(Tank calldata t, bytes calldata tankSig, Intent calldata i, bytes calldata intentSig)
        external
        payable
    {
        bytes32 id = _checkTank(t, tankSig, i, intentSig);
        _claim(i, t.cap - spent[id]); // the tank's room left
    }

    /// Settles the proof and pays the prover, atomically; callable only by the live claimant of exactly this intent.
    /// `v,r,s` is the payer's ERC-2612 permit to this contract (value maxFee, deadline); it is tried and ignored if it
    /// fails (an allowance may already stand), and the pull then reverts if the allowance is not there.
    function fulfill(
        Intent calldata i,
        bytes calldata signature,
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _checkDirect(i, signature);
        _run(i, bytes32(0), 0, i.maxFee, i.deadline, publicValues, proofBytes, memos, v, r, s);
    }

    /// The same out of a tank: the permit is the tank's (value `cap`, deadline `expiry`), signed once; every op after
    /// the first rides the allowance it left. The tank's running total can never pass its `cap`.
    function fulfillFromTank(
        Tank calldata t,
        bytes calldata tankSig,
        Intent calldata i,
        bytes calldata intentSig,
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        bytes32 id = _checkTank(t, tankSig, i, intentSig);
        _run(i, id, t.cap, t.cap, t.expiry, publicValues, proofBytes, memos, v, r, s);
    }

    function _claim(Intent calldata i, uint256 room) internal {
        if (msg.value != CLAIM_BOND) revert BadBond();
        Claim memory c = claims[i.opId];
        if (c.until > block.timestamp) revert Claimed();
        if (c.solver != address(0) && c.bond != 0) {
            SafeTransferLib.forceSafeTransferETH(TREASURY, c.bond); // a lapsed claim: its bond is forfeit
            emit Lapsed(i.opId, c.solver, c.bond);
        }
        uint256 p = priceAt(i, block.timestamp);
        if (p > room || (p != 0 && ITac(TAC).balanceOf(i.payer) < p)) revert Unfunded();
        uint64 until = uint64(block.timestamp) + CLAIM_WINDOW;
        claims[i.opId] = Claim(msg.sender, until, p, msg.value, intentHash(i));
        emit ClaimedOp(i.opId, msg.sender, p, until);
    }

    /// `tankId` 0 = direct. `cap` is the tank's total (checked against `spent`); `permitValue`/`permitDeadline` are what
    /// the payer's permit covers.
    function _run(
        Intent calldata i,
        bytes32 tankId,
        uint256 cap,
        uint256 permitValue,
        uint64 permitDeadline,
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        if (keccak256(publicValues) != i.opId) revert WrongOp();
        Claim memory c = claims[i.opId];
        if (c.solver != msg.sender || c.until <= block.timestamp || c.intentHash != intentHash(i)) revert NoClaim();
        uint256 price = c.price;
        if (tankId != bytes32(0)) {
            uint256 total = spent[tankId] + price;
            if (total > cap) revert TankSpent();
            spent[tankId] = total;
        }
        done[i.opId] = true;
        delete claims[i.opId];

        uint256 ethBefore = address(this).balance;
        try ITac(TAC).permit(i.payer, address(this), permitValue, permitDeadline, v, r, s) {} catch {}
        ISettlePool(POOL).settle(publicValues, proofBytes, memos);
        if (price != 0) SafeTransferLib.safeTransferFrom(TAC, i.payer, msg.sender, price);
        // what this settle paid in ETH (a fee leg), and the claim's bond: to the prover. Other ETH here is not touched.
        uint256 eth = address(this).balance - ethBefore + c.bond;
        if (eth != 0) SafeTransferLib.safeTransferETH(msg.sender, eth);
        emit Fulfilled(i.opId, i.payer, msg.sender, price);
    }

    function _checkDirect(Intent calldata i, bytes calldata signature) internal view {
        _checkIntent(i);
        if (i.tank != bytes32(0)) revert WrongMode();
        if (ECDSA.recoverCalldata(intentHash(i), signature) != i.payer) revert BadSignature();
    }

    function _checkTank(Tank calldata t, bytes calldata tankSig, Intent calldata i, bytes calldata intentSig)
        internal
        view
        returns (bytes32 id)
    {
        _checkIntent(i);
        id = tankHash(t);
        if (i.tank != id) revert WrongMode();
        if (tankRevoked[id]) revert TankRevoked();
        if (block.timestamp > t.expiry) revert Expired();
        if (i.payer != t.payer || i.maxFee > t.perOpMax) revert BadPrice();
        if (ECDSA.recoverCalldata(id, tankSig) != t.payer) revert BadSignature();
        if (ECDSA.recoverCalldata(intentHash(i), intentSig) != t.delegate) revert BadSignature();
    }

    function _checkIntent(Intent calldata i) internal view {
        if (block.timestamp > i.deadline) revert Expired();
        if (done[i.opId]) revert AlreadyDone();
        if (cancelled[i.payer][i.opId]) revert Cancelled();
        if (i.floorFee > i.maxFee) revert BadPrice();
    }
}
