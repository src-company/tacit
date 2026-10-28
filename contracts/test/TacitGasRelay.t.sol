// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {TacitGasRelay} from "../src/TacitGasRelay.sol";

contract Tok is ERC20 {
    string internal n;

    constructor(string memory n_) {
        n = n_;
    }

    function name() public view override returns (string memory) {
        return n;
    }

    function symbol() public pure override returns (string memory) {
        return "T";
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function domain() external view returns (bytes32) {
        return DOMAIN_SEPARATOR();
    }
}

/// a router that sells `tokenIn` for `tokenOut` 1:1 out of its own stock, spending `spend` of what it is approved for
contract MockRouter {
    function swap(Tok tin, Tok tout, uint256 pull, uint256 spend, address to) external {
        tin.transferFrom(msg.sender, address(this), spend);
        tout.transfer(to, spend);
        pull; // the approval is `pull`; only `spend` is used
    }

    function pullAll(Tok tin, uint256 a) external {
        tin.transferFrom(msg.sender, address(this), a);
    }
}

contract TacitGasRelayTest is Test {
    TacitGasRelay relay;
    Tok tac;
    Tok usdc;
    Tok weth;
    MockRouter router;
    uint256 payerKey = 0xA11CE;
    address payer;
    address relayer = address(0xBEEF);
    address recipient = address(0xCAFE);

    function setUp() public {
        tac = new Tok("Tacit Token");
        usdc = new Tok("USD Coin");
        weth = new Tok("Wrapped Ether");
        router = new MockRouter();
        address[] memory ts = new address[](1);
        ts[0] = address(router);
        relay = new TacitGasRelay(ts);
        payer = vm.addr(payerKey);
        tac.mint(payer, 1000e18);
        usdc.mint(payer, 5000e6);
        weth.mint(address(router), 100e18);
    }

    function _order(Tok tin, Tok feeTok, uint256 amt, uint256 fee, bytes memory data, uint256 nonce)
        internal
        view
        returns (TacitGasRelay.Order memory o)
    {
        o = TacitGasRelay.Order(
            payer, address(tin), amt, address(feeTok), fee, address(weth), amt, recipient, address(router), keccak256(data), uint64(block.timestamp + 600), nonce
        );
    }

    function _sign(TacitGasRelay.Order memory o) internal view returns (bytes memory) {
        bytes32 h = keccak256(
            abi.encode(
                relay.ORDER_TYPEHASH(), o.payer, o.tokenIn, o.amountIn, o.feeToken, o.fee, o.tokenOut, o.minOut, o.recipient, o.target, o.dataHash, o.deadline, o.nonce
            )
        );
        (, string memory nm, string memory ver,,,,) = relay.eip712Domain();
        bytes32 dom = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(nm)),
                keccak256(bytes(ver)),
                block.chainid,
                address(relay)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", dom, h)));
        return abi.encodePacked(r, s, v);
    }

    function _permit(Tok t, uint256 value) internal view returns (TacitGasRelay.Permit memory p) {
        uint256 dl = block.timestamp + 600;
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                payer,
                address(relay),
                value,
                t.nonces(payer),
                dl
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", t.domain(), sh)));
        p = TacitGasRelay.Permit(value, dl, v, r, s);
    }

    function _noP2() internal pure returns (TacitGasRelay.P2Auth memory a) {}

    function _none() internal pure returns (TacitGasRelay.Permit memory p) {}

    function _swapData(Tok tin, uint256 amt, uint256 spend) internal view returns (bytes memory) {
        return abi.encodeCall(MockRouter.swap, (tin, weth, amt, spend, address(relay)));
    }

    // fee in TAC, input USDC: two permits, the fee goes to the submitter, the output to the recipient
    function test_feeInTac() public {
        bytes memory d = _swapData(usdc, 1000e6, 1000e6);
        TacitGasRelay.Order memory o = _order(usdc, tac, 1000e6, 3e18, d, 1);
        bytes memory sig = _sign(o);
        TacitGasRelay.Permit memory p1 = _permit(usdc, 1000e6);
        TacitGasRelay.Permit memory p2 = _permit(tac, 3e18);
        vm.prank(relayer);
        relay.execute(o, sig, d, p1, p2, _noP2());
        assertEq(tac.balanceOf(relayer), 3e18);
        assertEq(tac.balanceOf(payer), 997e18);
        assertEq(usdc.balanceOf(payer), 4000e6);
        assertEq(weth.balanceOf(recipient), 1000e6);
        assertEq(usdc.allowance(address(relay), address(router)), 0);
        assertEq(usdc.balanceOf(address(relay)) + weth.balanceOf(address(relay)) + tac.balanceOf(address(relay)), 0);
    }

    // fee in the input token: one permit for amount + fee
    function test_feeInInputToken() public {
        bytes memory d = _swapData(usdc, 1000e6, 1000e6);
        TacitGasRelay.Order memory o = _order(usdc, usdc, 1000e6, 2e6, d, 2);
        bytes memory sig = _sign(o);
        TacitGasRelay.Permit memory p1 = _permit(usdc, 1002e6);
        vm.prank(relayer);
        relay.execute(o, sig, d, p1, _none(), _noP2());
        assertEq(usdc.balanceOf(relayer), 2e6);
        assertEq(usdc.balanceOf(payer), 5000e6 - 1002e6);
        assertEq(weth.balanceOf(recipient), 1000e6);
    }

    // input the router did not spend goes back to the payer
    function test_unspentInputRefunded() public {
        bytes memory d = _swapData(usdc, 1000e6, 600e6);
        TacitGasRelay.Order memory o = _order(usdc, tac, 1000e6, 1e18, d, 3);
        o.minOut = 600e6;
        bytes memory sig = _sign(o);
        TacitGasRelay.Permit memory p1 = _permit(usdc, 1000e6);
        TacitGasRelay.Permit memory p2 = _permit(tac, 1e18);
        vm.prank(relayer);
        relay.execute(o, sig, d, p1, p2, _noP2());
        assertEq(usdc.balanceOf(payer), 5000e6 - 600e6);
        assertEq(weth.balanceOf(recipient), 600e6);
        assertEq(usdc.balanceOf(address(relay)), 0);
    }

    function test_belowMinReverts_payerPaysNothing() public {
        bytes memory d = _swapData(usdc, 1000e6, 500e6);
        TacitGasRelay.Order memory o = _order(usdc, tac, 1000e6, 3e18, d, 4); // minOut 1000e6, gets 500e6
        bytes memory sig = _sign(o);
        TacitGasRelay.Permit memory p1 = _permit(usdc, 1000e6);
        TacitGasRelay.Permit memory p2 = _permit(tac, 3e18);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(TacitGasRelay.BelowMin.selector, 500e6, 1000e6));
        relay.execute(o, sig, d, p1, p2, _noP2());
        assertEq(tac.balanceOf(payer), 1000e18);
        assertEq(usdc.balanceOf(payer), 5000e6);
        assertEq(tac.balanceOf(relayer), 0);
    }

    function test_replayAndCancel() public {
        bytes memory d = _swapData(usdc, 100e6, 100e6);
        TacitGasRelay.Order memory o = _order(usdc, tac, 100e6, 1e18, d, 5);
        bytes memory sig = _sign(o);
        TacitGasRelay.Permit memory p1 = _permit(usdc, 200e6);
        TacitGasRelay.Permit memory p2 = _permit(tac, 2e18);
        relay.execute(o, sig, d, p1, p2, _noP2());
        vm.expectRevert(TacitGasRelay.Used.selector);
        relay.execute(o, sig, d, _none(), _none(), _noP2());
        TacitGasRelay.Order memory o2 = _order(usdc, tac, 100e6, 1e18, d, 6);
        bytes memory sig2 = _sign(o2);
        vm.prank(payer);
        relay.cancel(6);
        vm.expectRevert(TacitGasRelay.Used.selector);
        relay.execute(o2, sig2, d, _none(), _none(), _noP2());
    }

    function test_badSigDataExpiry() public {
        bytes memory d = _swapData(usdc, 100e6, 100e6);
        TacitGasRelay.Order memory o = _order(usdc, tac, 100e6, 1e18, d, 7);
        bytes memory sig = _sign(o);
        vm.expectRevert(TacitGasRelay.WrongData.selector);
        relay.execute(o, sig, _swapData(usdc, 100e6, 90e6), _none(), _none(), _noP2());
        o.fee = 2e18; // tampered after signing
        vm.expectRevert(TacitGasRelay.BadSignature.selector);
        relay.execute(o, sig, d, _none(), _none(), _noP2());
        o.fee = 1e18;
        vm.warp(block.timestamp + 601);
        vm.expectRevert(TacitGasRelay.Expired.selector);
        relay.execute(o, sig, d, _none(), _none(), _noP2());
    }

    // a call that tries to pull more than the order's amountIn cannot: the approval is exactly amountIn
    function test_cannotOverspend() public {
        bytes memory d = abi.encodeCall(MockRouter.pullAll, (usdc, 2000e6));
        TacitGasRelay.Order memory o = _order(usdc, tac, 1000e6, 1e18, d, 8);
        o.minOut = 0;
        o.dataHash = keccak256(d);
        TacitGasRelay.Permit memory p1 = _permit(usdc, 1000e6);
        TacitGasRelay.Permit memory p2 = _permit(tac, 1e18);
        bytes memory sig = _sign(o);
        vm.prank(relayer);
        vm.expectRevert();
        relay.execute(o, sig, d, p1, p2, _noP2());
        assertEq(usdc.balanceOf(payer), 5000e6);
    }

    function test_targetMustBeAllowed() public {
        bytes memory d = _swapData(usdc, 100e6, 100e6);
        TacitGasRelay.Order memory o = _order(usdc, tac, 100e6, 1e18, d, 12);
        o.target = address(0xdead);
        bytes memory sig = _sign(o);
        vm.expectRevert(TacitGasRelay.BadTarget.selector);
        relay.execute(o, sig, d, _none(), _none(), _noP2());
    }

    function test_refusesBadShapes() public {
        bytes memory d = _swapData(usdc, 100e6, 100e6);
        TacitGasRelay.Order memory o = _order(usdc, tac, 100e6, 1e18, d, 9);
        o.target = address(usdc);
        bytes memory sig = _sign(o);
        vm.expectRevert(TacitGasRelay.BadOrder.selector);
        relay.execute(o, sig, d, _none(), _none(), _noP2());
        o = _order(usdc, tac, 100e6, 1e18, d, 11);
        o.recipient = address(relay);
        sig = _sign(o);
        vm.expectRevert(TacitGasRelay.BadOrder.selector);
        relay.execute(o, sig, d, _none(), _none(), _noP2());
        o = _order(usdc, tac, 100e6, 1e18, d, 10);
        o.tokenOut = address(usdc);
        sig = _sign(o);
        vm.expectRevert(TacitGasRelay.BadOrder.selector);
        relay.execute(o, sig, d, _none(), _none(), _noP2());
    }
}
