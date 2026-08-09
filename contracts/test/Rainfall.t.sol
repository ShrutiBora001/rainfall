// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {MockUSDC, IERC20} from "../src/MockUSDC.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {CreditScore} from "../src/CreditScore.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {InstallmentAgreement} from "../src/InstallmentAgreement.sol";
import {Underwriter} from "../src/Underwriter.sol";

contract RainfallTest is Test {
    MockUSDC usdc;
    AgentRegistry registry;
    CreditScore score;
    LiquidityPool pool;
    InstallmentAgreement agreements;
    Underwriter underwriter;

    address owner = address(this);
    address agent = address(0xA6E7);
    address principal = address(0xBEEF);
    address merchant = address(0x5709); // phone store
    address lp = address(0x11D0);

    uint256 constant PHONE = 499e6;
    uint256 constant BIKE = 1200e6;
    uint64 constant CADENCE = 20;

    function setUp() public {
        usdc = new MockUSDC();
        registry = new AgentRegistry(owner);
        score = new CreditScore(owner);
        pool = new LiquidityPool(owner, IERC20(address(usdc)));
        agreements = new InstallmentAgreement(owner, IERC20(address(usdc)), score, pool);
        underwriter = new Underwriter(owner, registry, score, agreements);

        score.setAuthorized(address(agreements), true);
        // Demo-scale seasoning: one ladder step per cadence, matching deploy.
        score.setSeasoningPeriod(CADENCE);
        pool.setAuthorized(address(agreements), true);
        agreements.setAuthorized(address(underwriter), true);

        // Seed the pool so purchases can actually be funded.
        usdc.mint(lp, 100_000e6);
        vm.startPrank(lp);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(50_000e6);
        vm.stopPrank();

        registry.register(agent, principal, keccak256("collateral-contract"));

        // The agent earns; it repays from its own balance.
        usdc.mint(agent, 10_000e6);
        vm.prank(agent);
        usdc.approve(address(agreements), type(uint256).max);
    }

    // ---- the ladder ----

    function test_ColdAgentIsFullyCollateralized() public view {
        Underwriter.Assessment memory a = underwriter.assess(agent, PHONE);
        assertTrue(a.approved, "cold agent should still be approved");
        assertEq(a.requiredCollateralBps, 10_000, "cold agent must post full collateral");
        assertEq(a.creditLimit, 500e6);
    }

    function test_ColdAgentCannotAffordTheBike() public view {
        // $1,200 exceeds the $500 cold limit. This is the gap the ladder closes.
        assertFalse(underwriter.canAfford(agent, BIKE));
    }

    function test_RepaymentReleasesCollateralAndRaisesLimit() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);

        // Merchant is paid in full immediately, out of the pool.
        assertEq(usdc.balanceOf(merchant), PHONE, "merchant paid at t0");

        _payInstallments(id, 3);

        assertEq(score.requiredCollateralBps(agent), 5_000, "tier 1: half released");
        assertEq(score.creditLimit(agent), 750e6);

        // Settle the phone, then keep building history on a second plan.
        _payInstallments(id, 1);
        assertEq(uint8(_status(id)), uint8(InstallmentAgreement.Status.Settled));

        (uint256 id2,) = underwriter.authorize(agent, merchant, 400e6);
        _payInstallments(id2, 4);

        assertEq(score.requiredCollateralBps(agent), 0, "tier 2: uncollateralized");
        assertEq(score.creditLimit(agent), 1500e6);
    }

    function test_EarnedCreditUnlocksTheBike() public {
        _buildCleanHistory();

        Underwriter.Assessment memory a = underwriter.assess(agent, BIKE);
        assertTrue(a.approved, "bike should now clear");
        assertEq(a.requiredCollateralBps, 0, "on reputation alone");

        // Same agent, same code, different standing.
        (uint256 id,) = underwriter.authorize(agent, merchant, BIKE);
        assertEq(agreements.ownerOf(id), agent, "obligation minted to the agent");
    }

    // ---- the default path ----

    function test_MissedInstallmentGoesDelinquentAndRevokesCredit() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        _payInstallments(id, 1);

        // Blow past the due date plus grace.
        vm.warp(block.timestamp + CADENCE + 60);

        vm.expectEmit(true, true, false, false);
        emit InstallmentAgreement.AgreementDelinquent(id, agent, 0);
        agreements.markDelinquent(id);

        assertEq(uint8(_status(id)), uint8(InstallmentAgreement.Status.Delinquent));
        assertEq(score.creditLimit(agent), 0, "credit revoked");
        assertEq(score.requiredCollateralBps(agent), 10_000, "back to full collateral");

        Underwriter.Assessment memory a = underwriter.assess(agent, PHONE);
        assertFalse(a.approved);
        assertEq(a.reason, "credit revoked after default");
    }

    function test_DefaultWipesEarnedStanding() public {
        _buildCleanHistory();
        assertEq(score.requiredCollateralBps(agent), 0);

        (uint256 id,) = underwriter.authorize(agent, merchant, BIKE);
        vm.warp(block.timestamp + CADENCE + 60);
        agreements.markDelinquent(id);

        // Eight clean installments do not survive one default. Intentional.
        assertEq(score.requiredCollateralBps(agent), 10_000);
        assertEq(score.creditLimit(agent), 0);
    }

    function test_CannotMarkDelinquentBeforeGraceLapses() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        vm.expectRevert(InstallmentAgreement.NotDue.selector);
        agreements.markDelinquent(id);
    }

    function test_UnregisteredAgentIsDeclined() public view {
        Underwriter.Assessment memory a = underwriter.assess(address(0xDEAD), PHONE);
        assertFalse(a.approved);
        assertEq(a.reason, "agent not registered");
    }

    // ---- early payoff ----

    function test_PayoffSettlesTheWholeBalance() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        _payInstallments(id, 1);

        uint256 owed = agreements.outstandingOf(id);
        assertGt(owed, 0);

        vm.prank(agent);
        agreements.payoff(id);

        assertEq(uint8(_status(id)), uint8(InstallmentAgreement.Status.Settled));
        assertEq(agreements.outstandingOf(id), 0, "nothing left owing");
    }

    function test_PayoffCreditsEveryClearedInstallment() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        vm.prank(agent);
        agreements.payoff(id);
        // 4 installments cleared in one payment, all credited as repaid.
        assertEq(score.recordOf(agent).onTime, 4);
    }

    /// The exploit the seasoning window exists to close: four repayments in one
    /// block are four repayments, but they are one day's worth of standing.
    function test_PayoffCannotBuyTheLadder() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        vm.prank(agent);
        agreements.payoff(id);

        assertEq(score.recordOf(agent).onTime, 4, "all four repaid");
        assertEq(score.recordOf(agent).seasoned, 1, "but only one counts");
        assertEq(score.requiredCollateralBps(agent), 10_000, "still fully collateralized");
        assertEq(score.creditLimit(agent), 500e6, "still on the cold limit");
    }

    function test_SeasoningNeedsElapsedTime() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        // Three payments in quick succession, inside one seasoning window.
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + 1);
            vm.prank(agent);
            agreements.pay(id);
        }
        assertEq(score.recordOf(agent).onTime, 3);
        assertEq(score.recordOf(agent).seasoned, 1, "one window, one step");
        assertEq(score.requiredCollateralBps(agent), 10_000, "no tier without time");

        // Space the next ones out and the ladder moves.
        (uint256 id2,) = underwriter.authorize(agent, merchant, 400e6);
        _payInstallments(id2, 2);
        assertEq(score.recordOf(agent).seasoned, 3);
        assertEq(score.requiredCollateralBps(agent), 5_000, "tier 1 reached honestly");
    }

    function test_CannotPayoffTwice() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        vm.prank(agent);
        agreements.payoff(id);
        vm.expectRevert(InstallmentAgreement.NotActive.selector);
        vm.prank(agent);
        agreements.payoff(id);
    }

    // ---- late vs delinquent ----

    function test_LateIsNotYetDelinquent() public {
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        // Past the due date but inside the grace window.
        vm.warp(block.timestamp + CADENCE + 2);

        assertTrue(agreements.isLate(id), "should read as late");
        assertFalse(agreements.isDelinquent(id), "not delinquent yet");
        vm.expectRevert(InstallmentAgreement.NotDue.selector);
        agreements.markDelinquent(id);

        // Paying inside grace still counts as on time.
        vm.prank(agent);
        agreements.pay(id);
        assertEq(score.recordOf(agent).late, 0, "grace payment is not late");
    }

    // ---- pool accounting ----

    function test_PoolEarnsTheSpread() public {
        uint256 before = pool.totalAssets();
        (uint256 id,) = underwriter.authorize(agent, merchant, PHONE);
        _payInstallments(id, 4);
        assertGt(pool.totalAssets(), before, "LPs earn the APR spread");
    }

    // ---- helpers ----

    function _payInstallments(uint256 id, uint256 n) private {
        for (uint256 i = 0; i < n; i++) {
            vm.warp(block.timestamp + CADENCE);
            vm.prank(agent);
            agreements.pay(id);
        }
    }

    /// Eight on-time installments across two settled plans.
    function _buildCleanHistory() private {
        (uint256 a1,) = underwriter.authorize(agent, merchant, PHONE);
        _payInstallments(a1, 4);
        (uint256 a2,) = underwriter.authorize(agent, merchant, 400e6);
        _payInstallments(a2, 4);
    }

    function _status(uint256 id) private view returns (InstallmentAgreement.Status) {
        return agreements.statusOf(id);
    }
}
