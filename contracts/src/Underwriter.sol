// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Auth} from "./Auth.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {CreditScore} from "./CreditScore.sol";
import {InstallmentAgreement} from "./InstallmentAgreement.sol";

/// @notice The credit decision, made onchain, inside the card authorization
/// window.
///
/// This is the reason Rainfall is on Monad rather than anywhere else. A Visa
/// authorization will not wait: `assess` has to be read and the agreement
/// written while the terminal is still holding the line. At ~500ms blocks and
/// ~1s finality that fits. At 12s blocks it does not, and underwriting has to
/// move off-chain -- at which point the ledger degrades from a control into a
/// receipt, and the whole design stops meaning anything.
///
/// `assess` is a view and deliberately cheap: no loops, no external calls
/// beyond two storage reads.
contract Underwriter is Auth {
    AgentRegistry public immutable registry;
    CreditScore public immutable score;
    InstallmentAgreement public immutable agreements;

    uint16 public installments = 4;
    uint16 public aprBps = 800; // 8%
    uint64 public cadence = 20; // seconds; compressed for the demo

    struct Assessment {
        bool approved;
        uint16 installments;
        uint16 aprBps;
        uint16 requiredCollateralBps;
        uint256 creditLimit;
        string reason;
    }

    event Assessed(address indexed agent, uint256 amount, bool approved, uint16 collateralBps);
    event TermsUpdated(uint16 installments, uint16 aprBps, uint64 cadence);

    error NotApproved(string reason);

    constructor(
        address _owner,
        AgentRegistry _registry,
        CreditScore _score,
        InstallmentAgreement _agreements
    ) Auth(_owner) {
        registry = _registry;
        score = _score;
        agreements = _agreements;
    }

    function setTerms(uint16 _installments, uint16 _aprBps, uint64 _cadence)
        external
        onlyOwner
    {
        installments = _installments;
        aprBps = _aprBps;
        cadence = _cadence;
        emit TermsUpdated(_installments, _aprBps, _cadence);
    }

    /// @notice The whole decision in one call. Safe to run in the auth path.
    function assess(address agent, uint256 amount) public view returns (Assessment memory a) {
        a.installments = installments;
        a.aprBps = aprBps;
        a.requiredCollateralBps = score.requiredCollateralBps(agent);
        a.creditLimit = score.creditLimit(agent);

        if (registry.principalOf(agent) == address(0)) {
            a.reason = "agent not registered";
            return a;
        }
        if (!registry.isActive(agent)) {
            a.reason = "agent deactivated";
            return a;
        }
        if (a.creditLimit == 0) {
            a.reason = "credit revoked after default";
            return a;
        }
        if (amount > a.creditLimit) {
            a.reason = "exceeds credit limit";
            return a;
        }

        a.approved = true;
        a.reason = "approved";
    }

    uint16 public constant MIN_PLAN = 2;
    uint16 public constant MAX_PLAN = 12;

    error BadPlan(uint16 installments);

    /// @notice Assess and, if approved, open the agreement on the default plan.
    function authorize(address agent, address merchant, uint256 amount)
        external
        onlyAuthorized
        returns (uint256 id, Assessment memory a)
    {
        return _authorize(agent, merchant, amount, installments);
    }

    /// @notice Same, but on a plan the buyer chose at checkout. Every real
    /// installment product lets you pick the term; the underwriter still
    /// decides whether you get credit at all.
    function authorizeWithPlan(
        address agent,
        address merchant,
        uint256 amount,
        uint16 planInstallments
    ) external onlyAuthorized returns (uint256 id, Assessment memory a) {
        if (planInstallments < MIN_PLAN || planInstallments > MAX_PLAN) {
            revert BadPlan(planInstallments);
        }
        return _authorize(agent, merchant, amount, planInstallments);
    }

    function _authorize(address agent, address merchant, uint256 amount, uint16 plan)
        private
        returns (uint256 id, Assessment memory a)
    {
        a = assess(agent, amount);
        a.installments = plan;
        emit Assessed(agent, amount, a.approved, a.requiredCollateralBps);
        if (!a.approved) revert NotApproved(a.reason);

        id = agreements.open(
            agent, merchant, amount, plan, a.aprBps, a.requiredCollateralBps, cadence
        );
    }

    /// @notice Convenience read for the dashboard and the agent's own planning.
    function canAfford(address agent, uint256 amount) external view returns (bool) {
        return assess(agent, amount).approved;
    }
}
