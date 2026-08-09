// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {MockUSDC, IERC20} from "../src/MockUSDC.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {CreditScore} from "../src/CreditScore.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {InstallmentAgreement} from "../src/InstallmentAgreement.sol";
import {Underwriter} from "../src/Underwriter.sol";

/// @notice Deploys the full stack and wires every permission in one broadcast.
///
/// The wiring is the part that bites: three cross-contract authorizations that
/// produce confusing `NotAuthorized` reverts at demo time if any is missed.
/// They are asserted at the end rather than assumed.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        // Demo pacing: installments every 20s instead of monthly.
        uint64 cadence = uint64(vm.envOr("INSTALLMENT_INTERVAL_SECONDS", uint256(20)));

        vm.startBroadcast(pk);

        MockUSDC usdc = new MockUSDC();
        AgentRegistry registry = new AgentRegistry(deployer);
        CreditScore score = new CreditScore(deployer);
        LiquidityPool pool = new LiquidityPool(deployer, IERC20(address(usdc)));
        InstallmentAgreement agreements =
            new InstallmentAgreement(deployer, IERC20(address(usdc)), score, pool);
        Underwriter underwriter = new Underwriter(deployer, registry, score, agreements);

        // Only InstallmentAgreement may move the score or the pool.
        score.setAuthorized(address(agreements), true);
        pool.setAuthorized(address(agreements), true);
        // Only Underwriter may open agreements.
        agreements.setAuthorized(address(underwriter), true);

        underwriter.setTerms(4, 800, cadence);

        // Seed the pool so the first purchase can actually be funded.
        usdc.mint(deployer, 1_000_000e6);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(100_000e6);

        vm.stopBroadcast();

        require(score.authorized(address(agreements)), "score wiring failed");
        require(pool.authorized(address(agreements)), "pool wiring failed");
        require(agreements.authorized(address(underwriter)), "agreements wiring failed");

        console2.log("MockUSDC            ", address(usdc));
        console2.log("AgentRegistry       ", address(registry));
        console2.log("CreditScore         ", address(score));
        console2.log("LiquidityPool       ", address(pool));
        console2.log("InstallmentAgreement", address(agreements));
        console2.log("Underwriter         ", address(underwriter));
        console2.log("deployer            ", deployer);
        console2.log("pool liquidity      ", pool.totalAssets());
    }
}
