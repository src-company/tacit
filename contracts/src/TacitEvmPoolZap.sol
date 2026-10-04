// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// The one TacitEvmPool call a zap makes: a deposit, with the caller's own proof.
interface ITacitEvmPoolDeposit {
    function ASSET() external view returns (address);
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
    ) external payable;
}

interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// Permit2's signature transfers: a one-time signed pull, with no standing allowance in Permit2.
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/// @title TacitEvmPoolZap
/// @notice Shields a token into the ETH pool in one transaction: the caller's token is swapped through zRouter for ETH,
///         and exactly the deposit's `extAmount` goes into the pool with the caller's own deposit proof. What the swap
///         leaves (unspent input, ETH above the deposit) goes back to the caller.
///
///         The token is taken from the caller by an allowance to this contract (approved before, or in the same wallet
///         batch), an EIP-2612 permit, or a Permit2 signature transfer.
///
/// Trust model: holds nothing between transactions, takes tokens only from msg.sender, and gives zRouter an allowance
/// only within a call, reset to zero after the swap. The deposit is the caller's proof, so this contract chooses no
/// note, amount or fee. ETH is accepted only during a zap.
contract TacitEvmPoolZap {
    /// @notice The arguments of one TacitEvmPool.transact(), passed through verbatim (as TacitEvmPoolRouter.Tx).
    struct Tx {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[11] publicInputs;
        address recipient;
        int256 extAmount;
        address relayer;
        uint256 fee;
        bytes memo0;
        bytes memo1;
    }

    /// @notice The native-ETH TacitEvmPool deposits go into.
    ITacitEvmPoolDeposit public immutable POOL;
    /// @notice The swap aggregator the caller's route runs on.
    address public immutable ZROUTER;
    /// @notice Permit2, for signature transfers.
    ISignatureTransfer public immutable PERMIT2;

    bool transient zapping;

    error BadTarget();
    error NotADeposit();
    error ShortSwapOutput();
    error ZRouterCallFailed();
    error Reentered();
    error NotZapping();

    constructor(address pool, address zRouter, address permit2) {
        if (pool.code.length == 0 || zRouter.code.length == 0 || permit2.code.length == 0) revert BadTarget();
        if (ITacitEvmPoolDeposit(pool).ASSET() != address(0)) revert BadTarget();
        POOL = ITacitEvmPoolDeposit(pool);
        ZROUTER = zRouter;
        PERMIT2 = ISignatureTransfer(permit2);
    }

    modifier lock() {
        if (zapping) revert Reentered();
        zapping = true;
        _;
        zapping = false;
    }

    /// The swap's ETH output, during a zap only.
    receive() external payable {
        if (!zapping) revert NotZapping();
    }

    /// @notice Shield with `amountIn` of `tokenIn` the caller has allowed this contract. `swap` is zRouter calldata that
    ///         pays at least `t.extAmount` ETH to this contract; `t` deposits exactly that.
    function zapToken(Tx calldata t, address tokenIn, uint256 amountIn, bytes calldata swap) external lock {
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        _shield(t, tokenIn, amountIn, swap);
    }

    /// @notice As `zapToken`, with an EIP-2612 permit of `amountIn` to this contract. A failing permit is skipped (one
    ///         already used still leaves its allowance), so the pull decides.
    function zapTokenWithPermit(
        Tx calldata t,
        address tokenIn,
        uint256 amountIn,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata swap
    ) external lock {
        try IERC2612(tokenIn).permit(msg.sender, address(this), amountIn, deadline, v, r, s) {} catch {}
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        _shield(t, tokenIn, amountIn, swap);
    }

    /// @notice As `zapToken`, taking `amountIn` through a Permit2 `PermitTransferFrom` the caller signed for this
    ///         contract as spender.
    function zapTokenWithPermit2(
        Tx calldata t,
        address tokenIn,
        uint256 amountIn,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature,
        bytes calldata swap
    ) external lock {
        PERMIT2.permitTransferFrom(
            ISignatureTransfer.PermitTransferFrom(ISignatureTransfer.TokenPermissions(tokenIn, amountIn), nonce, deadline),
            ISignatureTransfer.SignatureTransferDetails(address(this), amountIn),
            msg.sender,
            signature
        );
        _shield(t, tokenIn, amountIn, swap);
    }

    function _shield(Tx calldata t, address tokenIn, uint256 amountIn, bytes calldata swap) internal {
        if (t.extAmount <= 0) revert NotADeposit();
        uint256 amount = uint256(t.extAmount);
        SafeTransferLib.safeApproveWithRetry(tokenIn, ZROUTER, amountIn);
        uint256 before = address(this).balance;
        (bool ok, bytes memory ret) = ZROUTER.call(swap);
        if (!ok) {
            if (ret.length != 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ZRouterCallFailed();
        }
        if (address(this).balance - before < amount) revert ShortSwapOutput();
        SafeTransferLib.safeApprove(tokenIn, ZROUTER, 0);
        POOL.transact{value: amount}(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
        uint256 left = SafeTransferLib.balanceOf(tokenIn, address(this));
        if (left != 0) SafeTransferLib.safeTransfer(tokenIn, msg.sender, left);
        if (address(this).balance != 0) SafeTransferLib.forceSafeTransferETH(msg.sender, address(this).balance);
    }
}
