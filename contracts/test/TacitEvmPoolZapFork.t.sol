// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter} from "../src/TacitEvmPoolRouter.sol";
import {TacitEvmPoolZap} from "../src/TacitEvmPoolZap.sol";
import {TxBuilder} from "./TacitEvmPoolRouter.t.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// FORK (skipped when no public node answers): shielding a stablecoin into the live ETH pool on Ethereum, Base and
/// Robinhood Chain through a zap deployed on the fork, with the route the live zQuoter builds and zRouter swapping on live
/// liquidity. Only the pool's verifier is mocked (any proof passes), so every other rule of the live pool applies. Each
/// way in (an allowance, an EIP-2612 permit, a Permit2 signature transfer) deposits exactly the amount, spends no more
/// than the route's limit, and leaves the zap holding nothing and allowing zRouter nothing.
contract TacitEvmPoolZapForkTest is TxBuilder {
    address constant POOL = 0x000000c2A20657CE25f2Ba99737933D031AFBEE9;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant ZQUOTER = 0x000000bd2DB80567c23E353ca95a251c573cBf9B;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    // Not a well-known test key: those have code (a 7702 delegation) on some of these chains.
    uint256 constant USER_PK = uint256(keccak256("tacit-evm-pool-zap fork user"));
    uint256 constant SLIP = 50;
    uint256 constant AMOUNT = 0.005 ether;

    address user;
    TacitEvmPoolZap zap;
    address token;
    uint256 roots;

    function _fork(string[2] memory rpcs) internal returns (bool) {
        for (uint256 i; i < rpcs.length; ++i) {
            try vm.createSelectFork(rpcs[i]) {
                return true;
            } catch {}
        }
        return false;
    }

    function _setUp(string[2] memory rpcs, address token_) internal returns (bool) {
        if (!_fork(rpcs)) return false;
        user = vm.addr(USER_PK);
        token = token_;
        zap = new TacitEvmPoolZap(POOL, ZROUTER, PERMIT2);
        vm.mockCall(
            address(TacitEvmPool(POOL).VERIFIER()),
            abi.encodeWithSignature("verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[11])"),
            abi.encode(true)
        );
        deal(token, user, 1_000e6);
        return true;
    }

    /// The live quoter's best exact-out route for AMOUNT ETH paid to the zap, and the most it may take.
    function _route() internal view returns (bytes memory swap, uint256 limit) {
        (bool ok, bytes memory ret) = ZQUOTER.staticcall(
            abi.encodeWithSelector(bytes4(0xe7798987), address(zap), true, token, address(0), AMOUNT, SLIP, block.timestamp + 900)
        );
        require(ok, "no route");
        uint256 amountIn;
        uint256 msgValue;
        (,, amountIn,, swap,, msgValue) = abi.decode(ret, (uint256, uint256, uint256, uint256, bytes, uint256, uint256));
        require(msgValue == 0 && amountIn != 0, "not a token-in route");
        limit = (amountIn * (10_000 + SLIP) + 9_999) / 10_000;
    }

    function _deposit() internal returns (TacitEvmPoolZap.Tx memory) {
        uint256 newRoot = uint256(keccak256(abi.encode("zap-fork", ++roots))) % P;
        TacitEvmPoolRouter.Tx memory t =
            _tx(TacitEvmPool(POOL), newRoot, 0, _leaves(newRoot ^ 1, 0), address(0), int256(AMOUNT), address(0), 0, "", "");
        return abi.decode(abi.encode(t), (TacitEvmPoolZap.Tx));
    }

    function _check(string memory how, uint256 poolBefore, uint256 tokBefore, uint256 limit, uint256 gasUsed) internal view {
        uint256 spent = tokBefore - IERC20Like(token).balanceOf(user);
        assertEq(POOL.balance, poolBefore + AMOUNT, "exactly the deposit");
        assertGt(spent, 0);
        assertLe(spent, limit, "no more than the route's limit");
        assertEq(address(zap).balance, 0, "zap holds no ETH");
        assertEq(IERC20Like(token).balanceOf(address(zap)), 0, "zap holds no token");
        assertEq(IERC20Like(token).allowance(address(zap), ZROUTER), 0, "zRouter allowance reset");
        console2.log(how, "spent", spent);
        console2.log("  limit", limit, "gas (verifier mocked)", gasUsed);
    }

    function _all() internal {
        IERC20Like tk = IERC20Like(token);

        // 1. An allowance (approved before, or in the same wallet batch).
        {
            (bytes memory swap, uint256 limit) = _route();
            TacitEvmPoolZap.Tx memory t = _deposit();
            (uint256 p0, uint256 b0) = (POOL.balance, tk.balanceOf(user));
            vm.prank(user);
            tk.approve(address(zap), limit);
            vm.prank(user);
            uint256 g = gasleft();
            zap.zapToken(t, token, limit, swap);
            _check("allowance:", p0, b0, limit, g - gasleft());
            assertEq(tk.allowance(user, address(zap)), 0, "the allowance is used up");
        }

        // 2. An EIP-2612 permit, when the token has one.
        (bool has2612,) = token.staticcall(abi.encodeWithSelector(IERC20Like.DOMAIN_SEPARATOR.selector));
        if (has2612) {
            (bytes memory swap, uint256 limit) = _route();
            TacitEvmPoolZap.Tx memory t = _deposit();
            uint256 deadline = block.timestamp + 1800;
            bytes32 digest = keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    tk.DOMAIN_SEPARATOR(),
                    keccak256(
                        abi.encode(
                            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                            user, address(zap), limit, tk.nonces(user), deadline
                        )
                    )
                )
            );
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
            (uint256 p0, uint256 b0) = (POOL.balance, tk.balanceOf(user));
            vm.prank(user);
            uint256 g = gasleft();
            zap.zapTokenWithPermit(t, token, limit, deadline, v, r, s, swap);
            _check("permit:", p0, b0, limit, g - gasleft());
        }

        // 3. A Permit2 signature transfer, once the token is approved to Permit2.
        {
            vm.prank(user);
            tk.approve(PERMIT2, type(uint256).max);
            (bytes memory swap, uint256 limit) = _route();
            TacitEvmPoolZap.Tx memory t = _deposit();
            uint256 nonce = uint256(keccak256("zap-fork-nonce")) >> 8;
            uint256 deadline = block.timestamp + 1800;
            bytes32 permitted = keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), token, limit));
            bytes32 data = keccak256(
                abi.encode(
                    keccak256(
                        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                    ),
                    permitted, address(zap), nonce, deadline
                )
            );
            (uint8 v, bytes32 r, bytes32 s) =
                vm.sign(USER_PK, keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), data)));
            (uint256 p0, uint256 b0) = (POOL.balance, tk.balanceOf(user));
            vm.prank(user);
            uint256 g = gasleft();
            zap.zapTokenWithPermit2(t, token, limit, nonce, deadline, abi.encodePacked(r, s, v), swap);
            _check("permit2:", p0, b0, limit, g - gasleft());
        }
    }

    function test_fork_ethereum_usdc() public {
        if (!_setUp(["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"], 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)) {
            vm.skip(true);
            return;
        }
        _all();
    }

    function test_fork_base_usdc() public {
        if (!_setUp(["https://base-rpc.publicnode.com", "https://mainnet.base.org"], 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)) {
            vm.skip(true);
            return;
        }
        _all();
    }

    function test_fork_robinhood_usdg() public {
        if (!_setUp(["https://rpc.mainnet.chain.robinhood.com", "https://rpc.mainnet.chain.robinhood.com"], 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168)) {
            vm.skip(true);
            return;
        }
        _all();
    }
}
