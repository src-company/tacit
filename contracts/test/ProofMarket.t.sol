// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {ProofMarket} from "../src/ProofMarket.sol";

/// A TAC stand-in with ERC-2612 permit (solady's ERC20 carries it).
contract MockTac is ERC20 {
    function name() public pure override returns (string memory) {
        return "TAC";
    }

    function symbol() public pure override returns (string memory) {
        return "TAC";
    }

    function mint(address to, uint256 n) external {
        _mint(to, n);
    }
}

/// Stands in for ConfidentialPool.settle: records the call, can refuse, can pay msg.sender a native-ETH fee leg.
contract MockPool {
    bytes32 public lastPv;
    uint256 public calls;
    bool public refuse;
    uint256 public payToCaller;

    function setRefuse(bool v) external {
        refuse = v;
    }

    function setPay(uint256 n) external {
        payToCaller = n;
    }

    function settle(bytes calldata pv, bytes calldata, bytes[] calldata) external {
        if (refuse) revert("pool refused");
        lastPv = keccak256(pv);
        calls++;
        if (payToCaller != 0) {
            (bool ok,) = msg.sender.call{value: payToCaller}("");
            require(ok);
        }
    }

    receive() external payable {}
}

contract ProofMarketTest is Test {
    MockTac tac;
    MockPool pool;
    ProofMarket mkt;

    uint256 payerKey = 0xA11CE;
    uint256 delegateKey = 0xDE1E6A7E;
    address payer;
    address solverA = address(0xA0);
    address solverB = address(0xB0);
    address treasury = address(0x7EA5);
    address owner = address(0x0A11);
    uint256 constant BOND = 0.01 ether;

    bytes pv = hex"c0ffee";
    bytes proof = hex"beef";
    bytes[] memos;

    function setUp() public {
        payer = vm.addr(payerKey);
        tac = new MockTac();
        pool = new MockPool();
        vm.deal(address(pool), 5 ether);
        mkt = new ProofMarket(address(pool), address(tac), 60, owner, treasury);
        tac.mint(payer, 1000e18);
        vm.deal(solverA, 1 ether);
        vm.deal(solverB, 1 ether);
        vm.warp(1_000_000);
        vm.prank(owner);
        mkt.setClaimBond(BOND); // the suite runs with a bond; the default is none
    }

    // ── helpers (every call into the market that prepares an argument is made BEFORE a prank) ──
    function _intent(bytes memory pv_, uint256 floor_, uint256 max_, uint64 ramp, bytes32 tank_)
        internal
        view
        returns (ProofMarket.Intent memory)
    {
        return ProofMarket.Intent(payer, keccak256(pv_), floor_, max_, uint64(block.timestamp), ramp, uint64(block.timestamp + 1 hours), tank_);
    }

    function _direct(uint256 floor_, uint256 max_, uint64 ramp) internal view returns (ProofMarket.Intent memory) {
        return _intent(pv, floor_, max_, ramp, bytes32(0));
    }

    function _sigBy(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function _sig(ProofMarket.Intent memory i) internal view returns (bytes memory) {
        return _sigBy(payerKey, mkt.intentHash(i));
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                payer,
                address(mkt),
                value,
                tac.nonces(payer),
                deadline
            )
        );
        (v, r, s) = vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", tac.DOMAIN_SEPARATOR(), structHash)));
    }

    function _claim(address who, ProofMarket.Intent memory i) internal {
        bytes memory sig = _sig(i);
        vm.prank(who);
        mkt.claim{value: BOND}(i, sig);
    }

    function _fulfillAsClaimant(address who, ProofMarket.Intent memory i, bytes memory pv_) internal {
        (uint8 v, bytes32 r, bytes32 s) = _permit(i.maxFee, i.deadline);
        bytes memory sig = _sig(i);
        vm.prank(who);
        mkt.fulfill(i, sig, pv_, proof, memos, v, r, s);
    }

    /// claim, then fulfil (a prover does these in separate blocks; the contract needs only that the claim is live)
    function _fulfill(address who, ProofMarket.Intent memory i) internal {
        _claim(who, i);
        _fulfillAsClaimant(who, i, pv);
    }

    // ── the happy path and its money ──
    function test_fulfillSettlesPaysTheProverAndReturnsTheBond() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        uint256 eth0 = solverA.balance;
        _fulfill(solverA, i);
        assertEq(pool.calls(), 1);
        assertEq(pool.lastPv(), keccak256(pv));
        assertEq(tac.balanceOf(solverA), 10e18, "ramp 0 = max price");
        assertEq(tac.balanceOf(payer), 990e18);
        assertEq(solverA.balance, eth0, "the bond came back");
        assertEq(address(mkt).balance, 0);
        assertTrue(mkt.done(i.opId));
    }

    function test_priceRisesFromFloorToMax() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 100);
        assertEq(mkt.priceAt(i, block.timestamp), 2e18);
        assertEq(mkt.priceAt(i, block.timestamp + 50), 6e18);
        assertEq(mkt.priceAt(i, block.timestamp + 100), 10e18);
        assertEq(mkt.priceAt(i, block.timestamp + 5000), 10e18);
        vm.warp(block.timestamp + 25);
        _fulfill(solverA, i);
        assertEq(tac.balanceOf(solverA), 4e18, "paid the price at that moment");
    }

    function test_theClaimedPriceHoldsEvenAsThePriceRises() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 100);
        _claim(solverA, i); // at the floor, 2
        vm.warp(block.timestamp + 50);
        _fulfillAsClaimant(solverA, i, pv);
        assertEq(tac.balanceOf(solverA), 2e18, "the claim fixed the price");
    }

    function test_poolRefusingRevertsAndMovesNoTac() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        _claim(solverA, i);
        pool.setRefuse(true);
        (uint8 v, bytes32 r, bytes32 s) = _permit(i.maxFee, i.deadline);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert("pool refused");
        mkt.fulfill(i, sig, pv, proof, memos, v, r, s);
        assertEq(tac.balanceOf(payer), 1000e18);
        assertEq(tac.balanceOf(solverA), 0);
        assertFalse(mkt.done(i.opId));
        assertEq(tac.allowance(payer, address(mkt)), 0, "the permit was rolled back with the rest");
        assertEq(address(mkt).balance, BOND, "the claim and its bond stand");
    }

    function test_proofForAnotherOpIsRefused() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        _claim(solverA, i);
        (uint8 v, bytes32 r, bytes32 s) = _permit(i.maxFee, i.deadline);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.WrongOp.selector);
        mkt.fulfill(i, sig, hex"deadbeef", proof, memos, v, r, s);
    }

    // ── claims: exclusivity, bond, expiry ──
    function test_aClaimExcludesEveryoneElse() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        _claim(solverA, i);
        bytes memory sig = _sig(i);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.Claimed.selector);
        mkt.claim{value: BOND}(i, sig);
        (uint8 v, bytes32 r, bytes32 s) = _permit(i.maxFee, i.deadline);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.NoClaim.selector);
        mkt.fulfill(i, sig, pv, proof, memos, v, r, s); // a copied proof cannot take the fee
        _fulfillAsClaimant(solverA, i, pv);
        assertEq(tac.balanceOf(solverA), 10e18);
        assertEq(tac.balanceOf(solverB), 0);
    }

    function test_aClaimCannotBeRenewedWhileLive() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        _claim(solverA, i);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.Claimed.selector);
        mkt.claim{value: BOND}(i, sig); // no squatting by renewing
    }

    function test_aLapsedClaimForfeitsItsBondAndOpensTheOp() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 100);
        _claim(solverA, i);
        vm.warp(block.timestamp + 61);
        _fulfill(solverB, i);
        assertEq(tac.balanceOf(solverB), 2e18 + (8e18 * 61) / 100);
        assertEq(treasury.balance, BOND, "A's lapsed bond went to the treasury");
        assertEq(address(mkt).balance, 0);
    }

    function test_fulfillWithoutAClaimIsRefused() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        (uint8 v, bytes32 r, bytes32 s) = _permit(i.maxFee, i.deadline);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.NoClaim.selector); // a copier of someone's calldata cannot just call fulfill
        mkt.fulfill(i, sig, pv, proof, memos, v, r, s);
        // and an expired claim is no claim
        _claim(solverA, i);
        vm.warp(block.timestamp + 61);
        (v, r, s) = _permit(i.maxFee, i.deadline);
        sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.NoClaim.selector);
        mkt.fulfill(i, sig, pv, proof, memos, v, r, s);
    }

    /// Audit F1: a solver claims under an intent of its OWN for the same op (floor = max = 1000) so that, holding the claim,
    /// it could fulfil the victim's intent at that price. The claim is bound to its intent, so it cannot.
    function test_aClaimUnderAnotherIntentCannotBeUsedForThePayersIntent() public {
        ProofMarket.Intent memory victim = _direct(1e18, 1000e18, 1000);
        uint256 attackerKey = 0xBAD1;
        address attacker = vm.addr(attackerKey);
        vm.deal(attacker, 1 ether);
        tac.mint(attacker, 5000e18);
        ProofMarket.Intent memory mine = _direct(1e18, 1000e18, 1000); // a separate copy: memory structs alias
        mine.payer = attacker;
        mine.floorFee = 1000e18;
        bytes memory mineSig = _sigBy(attackerKey, mkt.intentHash(mine));
        vm.prank(attacker);
        mkt.claim{value: BOND}(mine, mineSig); // valid: the attacker is the payer of ITS intent
        (uint8 v, bytes32 r, bytes32 s) = _permit(victim.maxFee, victim.deadline);
        bytes memory vs = _sig(victim);
        vm.prank(attacker);
        vm.expectRevert(ProofMarket.NoClaim.selector);
        mkt.fulfill(victim, vs, pv, proof, memos, v, r, s);
        assertEq(tac.balanceOf(attacker), 5000e18, "nothing was taken from the victim");
        assertEq(tac.balanceOf(payer), 1000e18);
    }

    function test_aClaimNeedsTheExactBondAndAFundedPayer() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadBond.selector);
        mkt.claim{value: BOND - 1}(i, sig);
        ProofMarket.Intent memory big = _direct(2e18, 5000e18, 0); // the payer holds 1000
        big.opId = keccak256("big");
        bytes memory bs = _sig(big);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.Unfunded.selector);
        mkt.claim{value: BOND}(big, bs);
    }

    // ── payer side ──
    function test_doubleFulfilIsRefused() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        _fulfill(solverA, i);
        bytes memory sig = _sig(i);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.AlreadyDone.selector);
        mkt.claim{value: BOND}(i, sig);
    }

    function test_cancelExpiryAndBadSignature() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        bytes memory sig = _sig(i);
        vm.prank(payer);
        mkt.cancel(i.opId);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.Cancelled.selector);
        mkt.claim{value: BOND}(i, sig);

        ProofMarket.Intent memory j = _direct(2e18, 10e18, 0);
        j.opId = keccak256("other");
        bytes memory bad = _sigBy(0xBAD, mkt.intentHash(j));
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadSignature.selector);
        mkt.claim{value: BOND}(j, bad);

        ProofMarket.Intent memory k = _direct(2e18, 10e18, 0);
        k.opId = keccak256("late");
        bytes memory ks = _sig(k);
        vm.warp(k.deadline + 1);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.Expired.selector);
        mkt.claim{value: BOND}(k, ks);
    }

    function test_theSignedMaxIsTheMostEverPulled() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        bytes memory sig = _sig(i);
        i.maxFee = 900e18; // altered after signing
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadSignature.selector);
        mkt.claim{value: BOND}(i, sig);
    }

    function test_theOpCannotBeCancelledWhileItIsClaimed() public {
        ProofMarket.Intent memory i = _direct(2e18, 10e18, 0);
        _claim(solverA, i);
        vm.prank(payer);
        vm.expectRevert(ProofMarket.Claimed.selector);
        mkt.cancel(i.opId);
        vm.warp(block.timestamp + 61);
        vm.prank(payer);
        mkt.cancel(i.opId); // once the claim has lapsed
    }

    // ── ETH and allowances ──
    function test_onlyTheEthASettlePaidGoesToTheProver_notWhatWasDonated() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(mkt).call{value: 0.5 ether}(""); // ETH forced or donated into the market
        assertTrue(ok);
        ProofMarket.Intent memory i = _direct(0, 1e18, 0);
        pool.setPay(0.01 ether);
        uint256 eth0 = solverA.balance;
        _fulfill(solverA, i);
        assertEq(solverA.balance, eth0 + 0.01 ether, "the fee leg, and the bond back; not the donation");
        assertEq(address(mkt).balance, 0.5 ether);
    }

    function test_worksWithAnAllowanceAndABadPermit() public {
        ProofMarket.Intent memory i = _direct(1e18, 1e18, 0);
        vm.prank(payer);
        tac.approve(address(mkt), 5e18);
        _claim(solverA, i);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        mkt.fulfill(i, sig, pv, proof, memos, 27, bytes32(0), bytes32(0)); // permit fails, allowance stands
        assertEq(tac.balanceOf(solverA), 1e18);
    }

    function test_withoutAnyAllowanceTheWholeCallReverts() public {
        ProofMarket.Intent memory i = _direct(1e18, 1e18, 0);
        _claim(solverA, i);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert();
        mkt.fulfill(i, sig, pv, proof, memos, 27, bytes32(0), bytes32(0));
        assertEq(pool.calls(), 0, "the settle was rolled back with the failed pull");
    }

    function test_constructorChecks() public {
        vm.expectRevert(ProofMarket.BadConfig.selector);
        new ProofMarket(address(0xD00D), address(tac), 60, owner, treasury);
        vm.expectRevert(ProofMarket.BadConfig.selector);
        new ProofMarket(address(pool), address(tac), 0, owner, treasury);
        vm.expectRevert(ProofMarket.BadConfig.selector);
        new ProofMarket(address(pool), address(tac), 60, owner, address(0));
    }

    // ── the proof tank: one signed package, many ops, never past the cap ──
    function _tank(uint256 cap, uint256 perOp) internal view returns (ProofMarket.Tank memory) {
        return ProofMarket.Tank(payer, vm.addr(delegateKey), cap, perOp, uint64(block.timestamp + 1 days), 1);
    }

    function _tankIntent(ProofMarket.Tank memory t, bytes memory pv_, uint256 max_) internal view returns (ProofMarket.Intent memory) {
        return _intent(pv_, 0, max_, 0, mkt.tankHash(t));
    }

    function _tankClaim(address who, ProofMarket.Tank memory t, ProofMarket.Intent memory i) internal {
        bytes memory ts = _sigBy(payerKey, mkt.tankHash(t));
        bytes memory is_ = _sigBy(delegateKey, mkt.intentHash(i));
        vm.prank(who);
        mkt.claimFromTank{value: BOND}(t, ts, i, is_);
    }

    function _tankFulfill(address who, ProofMarket.Tank memory t, bytes memory pv_, uint256 max_) internal {
        ProofMarket.Intent memory i = _tankIntent(t, pv_, max_);
        _tankClaim(who, t, i);
        (uint8 v, bytes32 r, bytes32 s) = _permit(t.cap, t.expiry);
        bytes memory ts = _sigBy(payerKey, mkt.tankHash(t));
        bytes memory is_ = _sigBy(delegateKey, mkt.intentHash(i));
        vm.prank(who);
        mkt.fulfillFromTank(t, ts, i, is_, pv_, proof, memos, v, r, s);
    }

    function test_tankOnePermitFundsManyOps() public {
        ProofMarket.Tank memory t = _tank(1000e18, 50e18);
        _tankFulfill(solverA, t, hex"01", 5e18);
        assertEq(tac.balanceOf(solverA), 5e18);
        assertEq(tac.allowance(payer, address(mkt)), 995e18, "the permit set the allowance; the pull used some");
        _tankFulfill(solverB, t, hex"02", 7e18);
        assertEq(tac.balanceOf(solverB), 7e18);
        assertEq(mkt.spent(mkt.tankHash(t)), 12e18);
        assertEq(tac.balanceOf(payer), 988e18);
        assertEq(pool.calls(), 2);
    }

    function test_tankNeverPaysPastItsCap() public {
        ProofMarket.Tank memory t = _tank(10e18, 6e18);
        _tankFulfill(solverA, t, hex"01", 6e18);
        ProofMarket.Intent memory i = _tankIntent(t, hex"02", 6e18);
        bytes memory ts = _sigBy(payerKey, mkt.tankHash(t));
        bytes memory is_ = _sigBy(delegateKey, mkt.intentHash(i));
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.Unfunded.selector); // 6 + 6 > 10: not even a claim
        mkt.claimFromTank{value: BOND}(t, ts, i, is_);
        _tankFulfill(solverB, t, hex"03", 4e18); // 6 + 4 = 10: exactly the cap
        assertEq(mkt.spent(mkt.tankHash(t)), 10e18);
        ProofMarket.Intent memory more = _tankIntent(t, hex"04", 1e18);
        is_ = _sigBy(delegateKey, mkt.intentHash(more));
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.Unfunded.selector); // the cap is reached: even 1 more is refused
        mkt.claimFromTank{value: BOND}(t, ts, more, is_);
    }

    function test_tankPerOpMaxSignersAndBinding() public {
        ProofMarket.Tank memory t = _tank(100e18, 5e18);
        bytes memory ts = _sigBy(payerKey, mkt.tankHash(t));

        ProofMarket.Intent memory big = _tankIntent(t, hex"01", 6e18);
        bytes memory bs = _sigBy(delegateKey, mkt.intentHash(big));
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadPrice.selector); // above perOpMax
        mkt.claimFromTank{value: BOND}(t, ts, big, bs);

        ProofMarket.Intent memory ok_ = _tankIntent(t, hex"02", 5e18);
        bytes memory payerSigned = _sigBy(payerKey, mkt.intentHash(ok_)); // the payer, not the delegate, signs the op
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadSignature.selector);
        mkt.claimFromTank{value: BOND}(t, ts, ok_, payerSigned);

        bytes memory badTank = _sigBy(delegateKey, mkt.tankHash(t)); // a tank signed by anyone but the payer
        bytes memory okSig = _sigBy(delegateKey, mkt.intentHash(ok_));
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadSignature.selector);
        mkt.claimFromTank{value: BOND}(t, badTank, ok_, okSig);

        // audit F5: an intent names its tank; it cannot be used under another tank of the same payer and delegate
        ProofMarket.Tank memory t2 = _tank(100e18, 5e18);
        t2.salt = 2;
        bytes memory ts2 = _sigBy(payerKey, mkt.tankHash(t2));
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.WrongMode.selector);
        mkt.claimFromTank{value: BOND}(t2, ts2, ok_, okSig);
        // and a tank's intent is not a direct one
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.WrongMode.selector);
        mkt.claim{value: BOND}(ok_, payerSigned);
    }

    function test_tankRevokeAndExpiry() public {
        ProofMarket.Tank memory t = _tank(100e18, 50e18);
        ProofMarket.Intent memory i = _tankIntent(t, hex"01", 5e18);
        bytes memory ts = _sigBy(payerKey, mkt.tankHash(t));
        bytes memory is_ = _sigBy(delegateKey, mkt.intentHash(i));
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.NotPayer.selector);
        mkt.revokeTank(t);
        vm.prank(payer);
        mkt.revokeTank(t);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.TankRevoked.selector);
        mkt.claimFromTank{value: BOND}(t, ts, i, is_);

        ProofMarket.Tank memory u = _tank(100e18, 50e18);
        u.salt = 3;
        bytes memory us = _sigBy(payerKey, mkt.tankHash(u));
        vm.warp(block.timestamp + 2 days);
        ProofMarket.Intent memory j = _tankIntent(u, hex"02", 5e18);
        j.deadline = uint64(block.timestamp + 1 hours);
        bytes memory js = _sigBy(delegateKey, mkt.intentHash(j));
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.Expired.selector);
        mkt.claimFromTank{value: BOND}(u, us, j, js);
    }

    function test_tankClaimExcludesOthers() public {
        ProofMarket.Tank memory t = _tank(100e18, 50e18);
        ProofMarket.Intent memory i = _tankIntent(t, hex"01", 5e18);
        _tankClaim(solverA, t, i);
        (uint8 v, bytes32 r, bytes32 s) = _permit(t.cap, t.expiry);
        bytes memory ts = _sigBy(payerKey, mkt.tankHash(t));
        bytes memory is_ = _sigBy(delegateKey, mkt.intentHash(i));
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.NoClaim.selector);
        mkt.fulfillFromTank(t, ts, i, is_, hex"01", proof, memos, v, r, s);
    }
}

contract ProofMarketBondTest is Test {
    ProofMarket mkt;
    address owner = address(0x0A11);

    function setUp() public {
        MockTac tac = new MockTac();
        mkt = new ProofMarket(address(new MockPool()), address(tac), 60, owner, address(0x7EA5));
    }

    function test_bondStartsAtZeroAndOnlyTheOwnerSetsIt() public {
        assertEq(mkt.claimBond(), 0);
        vm.expectRevert(ProofMarket.NotOwner.selector);
        mkt.setClaimBond(1);
        vm.startPrank(owner);
        mkt.setClaimBond(0.05 ether);
        assertEq(mkt.claimBond(), 0.05 ether);
        vm.expectRevert(ProofMarket.BadBond.selector);
        mkt.setClaimBond(0.1 ether + 1);
        vm.stopPrank();
    }
}
