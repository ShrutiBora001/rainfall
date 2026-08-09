// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Auth} from "./Auth.sol";
import {IERC20} from "./MockUSDC.sol";

/// @notice Funds purchases at t0 and collects installments over time.
///
/// This is what makes "agents actually move money" literal rather than
/// rhetorical: the merchant is paid in full the moment the card authorizes,
/// and the agent repays the pool afterwards. LPs earn the spread between the
/// two, which is the same trade every BNPL book runs.
contract LiquidityPool is Auth {
    IERC20 public immutable asset;

    uint256 public totalShares;
    uint256 public deployed; // principal currently out with agents
    mapping(address => uint256) public shares;

    event Deposited(address indexed lp, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed lp, uint256 amount, uint256 sharesBurned);
    event Funded(address indexed merchant, uint256 amount, uint256 indexed agreementId);
    event Repaid(uint256 indexed agreementId, uint256 amount);
    event LossRealized(uint256 indexed agreementId, uint256 amount);

    error ZeroAmount();
    error InsufficientLiquidity();
    error InsufficientShares();

    constructor(address _owner, IERC20 _asset) Auth(_owner) {
        asset = _asset;
    }

    /// @notice Idle cash plus principal still out with agents.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) + deployed;
    }

    function deposit(uint256 amount) external returns (uint256 minted) {
        if (amount == 0) revert ZeroAmount();
        uint256 assetsBefore = totalAssets();
        minted = totalShares == 0 ? amount : (amount * totalShares) / assetsBefore;

        asset.transferFrom(msg.sender, address(this), amount);
        shares[msg.sender] += minted;
        totalShares += minted;
        emit Deposited(msg.sender, amount, minted);
    }

    function withdraw(uint256 shareAmount) external returns (uint256 amount) {
        if (shareAmount == 0) revert ZeroAmount();
        if (shares[msg.sender] < shareAmount) revert InsufficientShares();

        amount = (shareAmount * totalAssets()) / totalShares;
        if (amount > asset.balanceOf(address(this))) revert InsufficientLiquidity();

        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        asset.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shareAmount);
    }

    /// @dev Called by InstallmentAgreement when a card authorization clears.
    function fundPurchase(address merchant, uint256 amount, uint256 agreementId)
        external
        onlyAuthorized
    {
        if (amount > asset.balanceOf(address(this))) revert InsufficientLiquidity();
        deployed += amount;
        asset.transfer(merchant, amount);
        emit Funded(merchant, amount, agreementId);
    }

    /// @dev Installments arrive here. Principal reduces `deployed`; anything
    /// above principal is yield and simply lifts the share price.
    function recordRepayment(uint256 agreementId, uint256 amount, uint256 principalPortion)
        external
        onlyAuthorized
    {
        deployed = deployed > principalPortion ? deployed - principalPortion : 0;
        emit Repaid(agreementId, amount);
    }

    /// @dev Unrecovered principal after collateral is claimed. Written off
    /// against the pool, which is what LPs are being paid to underwrite.
    function realizeLoss(uint256 agreementId, uint256 amount) external onlyAuthorized {
        deployed = deployed > amount ? deployed - amount : 0;
        emit LossRealized(agreementId, amount);
    }
}
