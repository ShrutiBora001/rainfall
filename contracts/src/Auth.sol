// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal owner + caller allowlist. Deliberately tiny: the contracts
/// that matter here are the credit ones, and pulling in a dependency tree for
/// two modifiers costs more than it saves.
abstract contract Auth {
    address public owner;
    mapping(address => bool) public authorized;

    event OwnerSet(address indexed owner);
    event AuthorizedSet(address indexed caller, bool allowed);

    error NotOwner();
    error NotAuthorized();

    constructor(address _owner) {
        owner = _owner;
        emit OwnerSet(_owner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Owner is implicitly authorized so deploy scripts and the demo
    /// harness can drive state without a second wiring step.
    modifier onlyAuthorized() {
        if (msg.sender != owner && !authorized[msg.sender]) revert NotAuthorized();
        _;
    }

    function setAuthorized(address caller, bool allowed) external onlyOwner {
        authorized[caller] = allowed;
        emit AuthorizedSet(caller, allowed);
    }

    function transferOwnership(address next) external onlyOwner {
        owner = next;
        emit OwnerSet(next);
    }
}
