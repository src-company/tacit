// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EIP712} from "solady/utils/EIP712.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";

interface IPermit2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface IPermit2Allowance {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitBatch {
        PermitDetails[] details;
        address spender;
        uint256 sigDeadline;
    }

    function permit(address owner, PermitBatch memory permitBatch, bytes calldata signature) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @title TacitGasRelay — a public DeFi call paid for in TAC (or the token being spent), with no ETH in the user's wallet
/// @notice The holder signs an ORDER: spend `amountIn` of `tokenIn` by calling `target` with exactly `data` (bound by its
///         hash), get at least `minOut` of `tokenOut` at `recipient`, and pay whoever submits it `fee` of `feeToken`
///         (TAC, or `tokenIn` itself). A relayer submits it and pays the gas. In ONE transaction the contract pulls the
///         input (and the fee) from the holder with their ERC-2612 permits, pays the fee to the submitter, approves
///         `target` for exactly `amountIn`, makes the signed call, forwards what came back to `recipient`, refunds any
///         input the call left unspent and clears the approval. If any step fails or `minOut` is not met the whole
///         transaction reverts, so the holder pays nothing and the relayer is out only its gas (which it simulates).
/// @dev    NO FUNDS, NO TRUST. Ownerless and immutable; it holds nothing between calls and keeps no standing allowance
///         on any token. The signed call is the holder's own instruction, as if they sent it, so it can move only what
///         this call pulled in (`amountIn`, approved to `target` for that and no more) and only against a signed
///         `minOut`. `tokenOut` must differ from `tokenIn` (the refund and the output are told apart by token) and a
///         zero `minOut` is allowed: it is then the holder's own choice to take any output.
///         WHAT THE CALL MAY DO is the holder's business, but `target` and `data` are shown to them before they sign, so
///         the page restricts them to known routers (the pool's router, zRouter). The contract itself refuses only
///         `target` = a token it handles (a signed call could otherwise act on this contract's own balances) and this
///         contract.
///         ONE-TIME ORDERS. `nonce` is a bitmap-free flat set per payer: an order runs once; the payer can `cancel` it.
///         Replay across chains or other contracts is closed by the EIP-712 domain.
///         PERMITS ARE TRIED, not required: a permit that fails (already used, front-run) is ignored and the pull then
///         succeeds on an allowance that already stands, or reverts. A tokenIn without ERC-2612 (USDT, WETH) uses
///         `p2`: the payer's Permit2 batch (one signature for the input and the fee), which works once the payer has approved
///         Permit2 for that token, a standing approval most wallets already gave.
///         A RELAYER'S RISK is its gas: a payer can cancel, move the tokens or sandwich their own swap between a
///         simulation and inclusion, and the revert costs the relayer its gas and the payer nothing. Relayers simulate
///         just before sending, send privately, and drop payers who do it. The allowlisted targets must be immutable
///         contracts: the call runs with an `amountIn` allowance, cleared after.
///         The submitter is whoever calls: the fee goes to `msg.sender`, so a front-runner who copies the order takes
///         the fee instead of the first relayer, which is fine (the holder pays the same fee once) and is what makes the
///         fee a market.
contract TacitGasRelay is EIP712, ReentrancyGuardTransient {
    struct Order {
        address payer; // signs the order; pays the input and the fee
        address tokenIn; // spent by the call (an ERC-20; wrap ETH first)
        uint256 amountIn; // exactly this is pulled and approved to `target`
        address feeToken; // TAC, or `tokenIn`
        uint256 fee; // paid to the submitter, in `feeToken`, on top of `amountIn`
        address tokenOut; // what the call returns (address(0) = ETH); not `tokenIn`
        uint256 minOut; // `recipient` must gain at least this
        address recipient; // gets the output and any unspent input stays with `payer`
        address target; // the contract the signed call goes to
        bytes32 dataHash; // keccak256 of the calldata that is run
        uint64 deadline;
        uint256 nonce; // any number the payer has not used
    }

    /// An ERC-2612 permit to this contract. `deadline` 0 = none supplied.
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address payer,address tokenIn,uint256 amountIn,address feeToken,uint256 fee,address tokenOut,uint256 minOut,address recipient,address target,bytes32 dataHash,uint64 deadline,uint256 nonce)"
    );

    /// An optional Permit2 authorization for the pulls, for a token with no ERC-2612 (USDT, WETH): the payer must have
    /// approved Permit2 for the token once before (a standing approval; the relay cannot do that for them). `use` false = none.
    struct P2Auth {
        bool use;
        IPermit2Allowance.PermitBatch batch;
        bytes sig;
    }

    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// The only contracts an order's call may go to, fixed at construction (the pool's routers and zRouter): a signed
    /// call to anything else is refused, so the holder cannot be shown, and a page cannot be tricked into signing, a call
    /// to an arbitrary contract.
    mapping(address => bool) public allowedTarget;
    mapping(address payer => mapping(uint256 nonce => bool)) public used;

    error BadSignature();
    error Expired();
    error Used();
    error WrongData();
    error BadOrder();
    error CallFailed(bytes reason);
    error BelowMin(uint256 got, uint256 min);
    error BadTarget();

    constructor(address[] memory targets) {
        if (targets.length == 0) revert BadTarget();
        for (uint256 i; i < targets.length; ++i) {
            if (targets[i] == address(0) || targets[i].code.length == 0) revert BadTarget();
            allowedTarget[targets[i]] = true;
        }
    }

    event Executed(address indexed payer, address indexed submitter, uint256 indexed nonce, address feeToken, uint256 fee);
    event Cancelled(address indexed payer, uint256 indexed nonce);

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("TacitGasRelay", "1");
    }

    function orderHash(Order calldata o) public view returns (bytes32) {
        return _hashTypedData(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    o.payer,
                    o.tokenIn,
                    o.amountIn,
                    o.feeToken,
                    o.fee,
                    o.tokenOut,
                    o.minOut,
                    o.recipient,
                    o.target,
                    o.dataHash,
                    o.deadline,
                    o.nonce
                )
            )
        );
    }

    /// The payer withdraws an order that has not run.
    function cancel(uint256 nonce) external {
        used[msg.sender][nonce] = true;
        emit Cancelled(msg.sender, nonce);
    }

    /// Runs the signed order; the fee goes to the caller. `inPermit` covers `tokenIn` (and the fee too when `feeToken`
    /// is `tokenIn`, in which case its value must be `amountIn + fee`); `feePermit` covers `feeToken` when it is another token.
    function execute(
        Order calldata o,
        bytes calldata signature,
        bytes calldata data,
        Permit calldata inPermit,
        Permit calldata feePermit,
        P2Auth calldata p2
    ) external nonReentrant {
        if (block.timestamp > o.deadline) revert Expired();
        if (used[o.payer][o.nonce]) revert Used();
        if (keccak256(data) != o.dataHash) revert WrongData();
        if (
            o.tokenIn == o.tokenOut || o.amountIn == 0 || o.recipient == address(0) || o.recipient == address(this) || o.target == address(this)
                || o.target == o.tokenIn || o.target == o.feeToken || o.target == o.tokenOut
                || (o.feeToken != o.tokenIn && o.fee != 0 && o.feeToken.code.length == 0) || o.tokenIn.code.length == 0
        ) revert BadOrder();
        if (!allowedTarget[o.target]) revert BadTarget();
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(o.payer, orderHash(o), signature)) revert BadSignature();
        used[o.payer][o.nonce] = true;

        assembly {
            tstore(0x7a5e11, 1)
        }
        // the input, and the fee (to the submitter first: a failed call reverts it all)
        if (p2.use) {
            if (p2.batch.spender != address(this)) revert BadOrder();
            try IPermit2Allowance(PERMIT2).permit(o.payer, p2.batch, p2.sig) {} catch {}
        } else {
            _permit(o.tokenIn, o.payer, inPermit);
            if (o.feeToken != o.tokenIn && o.fee != 0) _permit(o.feeToken, o.payer, feePermit);
        }
        if (o.fee != 0) _pull(o.feeToken, o.payer, msg.sender, o.fee, p2.use);
        uint256 inBefore = SafeTransferLib.balanceOf(o.tokenIn, address(this));
        _pull(o.tokenIn, o.payer, address(this), o.amountIn, p2.use);
        if (SafeTransferLib.balanceOf(o.tokenIn, address(this)) - inBefore != o.amountIn) revert BadOrder(); // no fee-on-transfer or rebasing input

        uint256 outBefore = _balance(o.tokenOut, address(this));
        uint256 toBefore = _balance(o.tokenOut, o.recipient);
        SafeTransferLib.safeApprove(o.tokenIn, o.target, o.amountIn);
        (bool ok, bytes memory ret) = o.target.call(data);
        if (!ok) revert CallFailed(ret);
        SafeTransferLib.safeApprove(o.tokenIn, o.target, 0);

        // what came back here goes to the recipient; what went to the recipient directly counts the same
        uint256 got = _balance(o.tokenOut, address(this)) - outBefore;
        if (got != 0) _send(o.tokenOut, o.recipient, got);
        uint256 gained = _balance(o.tokenOut, o.recipient) - toBefore;
        if (gained < o.minOut) revert BelowMin(gained, o.minOut);

        // input the call did not spend goes back to the payer
        uint256 left = SafeTransferLib.balanceOf(o.tokenIn, address(this)) - inBefore;
        if (left != 0) SafeTransferLib.safeTransfer(o.tokenIn, o.payer, left);
        assembly {
            tstore(0x7a5e11, 0)
        }
        emit Executed(o.payer, msg.sender, o.nonce, o.feeToken, o.fee);
    }

    function _pull(address token, address from, address to, uint256 amount, bool viaPermit2) internal {
        if (!viaPermit2) return SafeTransferLib.safeTransferFrom(token, from, to, amount);
        if (amount > type(uint160).max) revert BadOrder();
        IPermit2Allowance(PERMIT2).transferFrom(from, to, uint160(amount), token);
    }

    function _permit(address token, address owner, Permit calldata p) internal {
        if (p.deadline == 0) return;
        try IPermit2612(token).permit(owner, address(this), p.value, p.deadline, p.v, p.r, p.s) {} catch {}
    }

    function _balance(address token, address who) internal view returns (uint256) {
        return token == address(0) ? who.balance : SafeTransferLib.balanceOf(token, who);
    }

    function _send(address token, address to, uint256 amount) internal {
        if (token == address(0)) SafeTransferLib.safeTransferETH(to, amount);
        else SafeTransferLib.safeTransfer(token, to, amount);
    }

    /// ETH is accepted only while an order runs (an output to ETH): a stray send would be stranded, so it reverts.
    receive() external payable {
        bool running;
        assembly {
            running := tload(0x7a5e11)
        }
        if (!running) revert BadOrder();
    }
}
