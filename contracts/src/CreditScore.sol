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
        uint16 score; // FICO range, 300..850
        /// Repayments that advanced the ladder. Always <= onTime.
        uint32 seasoned;
        /// When the last seasoned repayment was counted.
        uint64 lastSeasonedAt;
    }

    mapping(address => Record) private records;

    /// Ladder thresholds. Public so the dashboard and the pitch agree with the
    /// contract rather than restating it.
    uint32 public constant TIER1_ONTIME = 3; // collateral 100% -> 50%
    uint32 public constant TIER2_ONTIME = 8; // collateral 50%  -> 0%

    uint256 public constant LIMIT_COLD = 500e6; // $500
    uint256 public constant LIMIT_TIER1 = 750e6; // $750
    uint256 public constant LIMIT_TIER2 = 1500e6; // $1,500

    /// @notice Minimum spacing between two repayments that both count toward
    /// the ladder.
    ///
    /// Without this, creditworthiness is purely a counter, and a counter can be
    /// bought: an agent holding cash could open a plan, settle it immediately,
    /// and book four "on-time" repayments in a single block -- climbing to
    /// uncollateralized without ever having been trusted overnight. What the
    /// ladder is supposed to measure is reliability *over time*, so time has to
    /// be part of the measurement.
    ///
    /// Repayments inside the window still count as repaid and still clear the
    /// debt. They just don't buy standing.
    uint64 public seasoningPeriod = 1 days;

    /// FICO-range scoring, so the number means something to anyone who has
    /// ever applied for credit. 300 is the floor, 850 the ceiling, and a new
    /// agent opens at 580 -- a thin file, not a bad one.
    ///   300-579 poor · 580-669 fair · 670-739 good
    ///   740-799 very good · 800-850 exceptional
    uint16 public constant SCORE_MIN = 300;
    uint16 public constant SCORE_START = 580;
    uint16 public constant SCORE_MAX = 850;
    uint16 public constant SCORE_ON_TIME = 25;
    uint16 public constant SCORE_LATE = 60; // penalty
    uint16 public constant SCORE_DEFAULT = 240; // penalty

    event RepaymentRecorded(address indexed agent, uint256 amount, bool onTime, uint16 score);
    event DefaultRecorded(address indexed agent, uint16 score);
    event TierChanged(address indexed agent, uint16 requiredCollateralBps, uint256 creditLimit);
    event SeasonedRepayment(address indexed agent, uint32 seasoned);
    event SeasoningPeriodSet(uint64 seconds_);

    constructor(address _owner) Auth(_owner) {}

    function recordRepayment(address agent, uint256 amount, bool onTime)
        external
        onlyAuthorized
    {
        Record storage r = records[agent];
        _seed(r);

        uint16 before = requiredCollateralBps(agent);

        if (onTime) {
            r.onTime += 1;
            uint16 next = r.score + SCORE_ON_TIME;
            r.score = next > SCORE_MAX ? SCORE_MAX : next;

            // Only a repayment far enough from the last counted one advances
            // the ladder. The first is always free -- there is nothing to
            // space it against.
            if (r.lastSeasonedAt == 0 || block.timestamp >= r.lastSeasonedAt + seasoningPeriod) {
                r.seasoned += 1;
                r.lastSeasonedAt = uint64(block.timestamp);
                emit SeasonedRepayment(agent, r.seasoned);
            }
        } else {
            r.late += 1;
            r.score = r.score > SCORE_MIN + SCORE_LATE ? r.score - SCORE_LATE : SCORE_MIN;
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
        _seed(r);
        r.defaults += 1;
        r.score = r.score > SCORE_MIN + SCORE_DEFAULT ? r.score - SCORE_DEFAULT : SCORE_MIN;
        emit DefaultRecorded(agent, r.score);
        emit TierChanged(agent, requiredCollateralBps(agent), creditLimit(agent));
    }

    /// @dev A record's score is 0 until it is touched. Seeding here rather than
    /// in each writer keeps a first default and a first repayment starting from
    /// the same place -- otherwise an agent that defaults before ever repaying
    /// drops straight to the floor instead of taking the penalty from SCORE_START.
    function _seed(Record storage r) private {
        if (r.score == 0 && r.onTime == 0 && r.late == 0 && r.defaults == 0) {
            r.score = SCORE_START;
        }
    }

    // ---- the ladder ----

    function setSeasoningPeriod(uint64 s) external onlyOwner {
        seasoningPeriod = s;
        emit SeasoningPeriodSet(s);
    }

    /// @notice How much of the purchase must stay locked in the agent's Rain
    /// collateral contract. 10_000 bps = fully collateralized.
    /// @dev Reads `seasoned`, not `onTime` -- see `seasoningPeriod`.
    function requiredCollateralBps(address agent) public view returns (uint16) {
        Record memory r = records[agent];
        if (r.defaults > 0) return 10_000;
        if (r.seasoned >= TIER2_ONTIME) return 0;
        if (r.seasoned >= TIER1_ONTIME) return 5_000;
        return 10_000;
    }

    function creditLimit(address agent) public view returns (uint256) {
        Record memory r = records[agent];
        if (r.defaults > 0) return 0;
        if (r.seasoned >= TIER2_ONTIME) return LIMIT_TIER2;
        if (r.seasoned >= TIER1_ONTIME) return LIMIT_TIER1;
        return LIMIT_COLD;
    }

    /// @notice Repayments that counted toward the ladder, and how many more
    /// the agent needs for its next tier. Surfaced so the portal can explain
    /// a decline instead of just reporting it.
    function seasonedOf(address agent) external view returns (uint32) {
        return records[agent].seasoned;
    }

    function nextTierIn(address agent) external view returns (uint32) {
        Record memory r = records[agent];
        if (r.defaults > 0) return type(uint32).max; // no path back
        if (r.seasoned >= TIER2_ONTIME) return 0;
        if (r.seasoned >= TIER1_ONTIME) return TIER2_ONTIME - r.seasoned;
        return TIER1_ONTIME - r.seasoned;
    }

    function scoreOf(address agent) external view returns (uint16) {
        Record memory r = records[agent];
        return (r.score == 0 && r.onTime == 0 && r.defaults == 0) ? SCORE_START : r.score;
    }

    /// @notice The band the score sits in, so a UI does not have to hardcode
    /// the thresholds and drift from the contract.
    function scoreBand(address agent) external view returns (string memory) {
        Record memory r = records[agent];
        uint16 sc = (r.score == 0 && r.onTime == 0 && r.defaults == 0) ? SCORE_START : r.score;
        if (sc >= 800) return "exceptional";
        if (sc >= 740) return "very good";
        if (sc >= 670) return "good";
        if (sc >= 580) return "fair";
        return "poor";
    }

    function recordOf(address agent) external view returns (Record memory) {
        return records[agent];
    }
}
