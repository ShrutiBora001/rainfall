// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Auth} from "./Auth.sol";

/// @notice Portable, onchain creditworthiness for autonomous agents.
///
/// This is the piece agentic commerce is missing. Rain, x402, AP2 and the rest
/// all bound an agent by a spend cap: it may spend money that already exists in
/// a pot someone pre-funded. None of them let an agent accumulate standing.
/// Here, repayment history is public state that any contract can read, so an
/// agent's record follows it to the next merchant instead of dying inside one
/// provider's database.
///
/// Deliberately readable by everyone and writable by almost no one.
contract CreditScore is Auth {
    struct Record {
        uint32 onTime;
        uint32 late;
        uint32 defaults;
        uint96 totalRepaid; // base units, lifetime
        uint16 score; // 0..1000
    }

    mapping(address => Record) private records;

    /// Ladder thresholds. Public so the dashboard and the pitch agree with the
    /// contract rather than restating it.
    uint32 public constant TIER1_ONTIME = 3; // collateral 100% -> 50%
    uint32 public constant TIER2_ONTIME = 8; // collateral 50%  -> 0%

    uint256 public constant LIMIT_COLD = 500e6; // $500
    uint256 public constant LIMIT_TIER1 = 750e6; // $750
    uint256 public constant LIMIT_TIER2 = 1500e6; // $1,500

    uint16 public constant SCORE_START = 500;
    uint16 public constant SCORE_MAX = 1000;
    uint16 public constant SCORE_ON_TIME = 40;
    uint16 public constant SCORE_LATE = 80; // penalty
    uint16 public constant SCORE_DEFAULT = 400; // penalty

    event RepaymentRecorded(address indexed agent, uint256 amount, bool onTime, uint16 score);
    event DefaultRecorded(address indexed agent, uint16 score);
    event TierChanged(address indexed agent, uint16 requiredCollateralBps, uint256 creditLimit);

    constructor(address _owner) Auth(_owner) {}

    function recordRepayment(address agent, uint256 amount, bool onTime)
        external
        onlyAuthorized
    {
        Record storage r = records[agent];
        if (r.score == 0 && r.onTime == 0 && r.late == 0 && r.defaults == 0) {
            r.score = SCORE_START;
        }

        uint16 before = requiredCollateralBps(agent);

        if (onTime) {
            r.onTime += 1;
            uint16 next = r.score + SCORE_ON_TIME;
            r.score = next > SCORE_MAX ? SCORE_MAX : next;
        } else {
            r.late += 1;
            r.score = r.score > SCORE_LATE ? r.score - SCORE_LATE : 0;
        }
        r.totalRepaid += uint96(amount);

        emit RepaymentRecorded(agent, amount, onTime, r.score);

        uint16 nowBps = requiredCollateralBps(agent);
        if (nowBps != before) emit TierChanged(agent, nowBps, creditLimit(agent));
    }

    /// @dev A default is terminal for the ladder, not merely expensive. Credit
    /// that survives non-payment is not credit.
    function recordDefault(address agent) external onlyAuthorized {
        Record storage r = records[agent];
        r.defaults += 1;
        r.score = r.score > SCORE_DEFAULT ? r.score - SCORE_DEFAULT : 0;
        emit DefaultRecorded(agent, r.score);
        emit TierChanged(agent, requiredCollateralBps(agent), creditLimit(agent));
    }

    // ---- the ladder ----

    /// @notice How much of the purchase must stay locked in the agent's Rain
    /// collateral contract. 10_000 bps = fully collateralized.
    function requiredCollateralBps(address agent) public view returns (uint16) {
        Record memory r = records[agent];
        if (r.defaults > 0) return 10_000;
        if (r.onTime >= TIER2_ONTIME) return 0;
        if (r.onTime >= TIER1_ONTIME) return 5_000;
        return 10_000;
    }

    function creditLimit(address agent) public view returns (uint256) {
        Record memory r = records[agent];
        if (r.defaults > 0) return 0;
        if (r.onTime >= TIER2_ONTIME) return LIMIT_TIER2;
        if (r.onTime >= TIER1_ONTIME) return LIMIT_TIER1;
        return LIMIT_COLD;
    }

    function scoreOf(address agent) external view returns (uint16) {
        Record memory r = records[agent];
        return (r.score == 0 && r.onTime == 0 && r.defaults == 0) ? SCORE_START : r.score;
    }

    function recordOf(address agent) external view returns (Record memory) {
        return records[agent];
    }
}
