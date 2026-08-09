// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Auth} from "./Auth.sol";

/// @notice Answers the question every credit system must answer first:
/// when this agent doesn't pay, who is liable?
///
/// An agent is a session key. The principal is the human or business behind
/// it. Credit is extended to the pair, never to the key alone -- a key can be
/// rotated, and reputation that a rotation erases is not reputation.
contract AgentRegistry is Auth {
    struct Agent {
        address principal;
        bytes32 rainCardRef; // hash of the Rain card id; never store it raw
        bytes32 collateralRef; // hash of the Rain collateral contract id
        bool active;
        uint64 registeredAt;
    }

    mapping(address => Agent) public agents;
    address[] public agentList;

    event AgentRegistered(address indexed agent, address indexed principal);
    event AgentDeactivated(address indexed agent);
    event CardRefSet(address indexed agent, bytes32 rainCardRef);

    error AlreadyRegistered();
    error UnknownAgent();

    constructor(address _owner) Auth(_owner) {}

    function register(address agent, address principal, bytes32 collateralRef)
        external
        onlyAuthorized
    {
        if (agents[agent].principal != address(0)) revert AlreadyRegistered();
        agents[agent] = Agent({
            principal: principal,
            rainCardRef: bytes32(0),
            collateralRef: collateralRef,
            active: true,
            registeredAt: uint64(block.timestamp)
        });
        agentList.push(agent);
        emit AgentRegistered(agent, principal);
    }

    /// @dev Rebound on every purchase: cards are single-use and short-lived by
    /// design, so the current card ref is expected to churn.
    function setCardRef(address agent, bytes32 rainCardRef) external onlyAuthorized {
        if (agents[agent].principal == address(0)) revert UnknownAgent();
        agents[agent].rainCardRef = rainCardRef;
        emit CardRefSet(agent, rainCardRef);
    }

    function deactivate(address agent) external onlyAuthorized {
        if (agents[agent].principal == address(0)) revert UnknownAgent();
        agents[agent].active = false;
        emit AgentDeactivated(agent);
    }

    function principalOf(address agent) external view returns (address) {
        return agents[agent].principal;
    }

    function isActive(address agent) external view returns (bool) {
        return agents[agent].active;
    }

    function agentCount() external view returns (uint256) {
        return agentList.length;
    }
}
