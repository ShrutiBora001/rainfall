// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Auth} from "./Auth.sol";
import {IERC20} from "./MockUSDC.sol";
import {CreditScore} from "./CreditScore.sol";
import {LiquidityPool} from "./LiquidityPool.sol";

/// @notice The obligation itself: an EMI plan minted when a card authorizes.
///
/// Minimal ERC-721 on purpose. The token is not decoration -- an obligation
/// that can be held and transferred is an obligation that can be sold, which
/// is how consumer credit books actually work. Rainfall does not build that
/// market, but it refuses to foreclose it.
contract InstallmentAgreement is Auth {
    enum Status {
        None,
        Active,
        Settled,
        Delinquent
    }

    struct Agreement {
        address agent;
        address merchant;
        uint256 principal; // base units financed
        uint256 installmentAmount; // per-installment, principal + interest
        uint16 installments;
        uint16 paid;
        uint16 aprBps;
        uint16 collateralBps; // required at origination
        uint64 cadence; // seconds between installments
        uint64 nextDueAt;
        Status status;
    }

    IERC20 public immutable asset;
    CreditScore public immutable score;
    LiquidityPool public immutable pool;

    uint64 public graceSeconds = 5; // compressed for the demo; days in reality

    uint256 public nextId = 1;
    mapping(uint256 => Agreement) public agreements;
    mapping(address => uint256[]) public agreementsOf;

    // --- minimal ERC-721 ---
    string public constant name = "Rainfall Obligation";
    string public constant symbol = "RAINOBL";
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed approved, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event AgreementOpened(
        uint256 indexed id,
        address indexed agent,
        address indexed merchant,
        uint256 principal,
        uint16 installments,
        uint16 collateralBps
    );
    event InstallmentPaid(uint256 indexed id, uint16 number, uint256 amount, bool onTime);
    event AgreementSettled(uint256 indexed id);
    /// @dev The keeper watches this and freezes the Rain card on sight.
    event AgreementDelinquent(uint256 indexed id, address indexed agent, uint256 outstanding);

    error NotActive();
    error NotDue();
    error AlreadySettled();
    error NotOwnerOrApproved();

    constructor(address _owner, IERC20 _asset, CreditScore _score, LiquidityPool _pool)
        Auth(_owner)
    {
        asset = _asset;
        score = _score;
        pool = _pool;
    }

    function setGrace(uint64 s) external onlyOwner {
        graceSeconds = s;
    }

    /// @notice Called once a card authorization clears. Mints the obligation
    /// and pays the merchant in full out of the pool.
    function open(
        address agent,
        address merchant,
        uint256 principal,
        uint16 installments,
        uint16 aprBps,
        uint16 collateralBps,
        uint64 cadence
    ) external onlyAuthorized returns (uint256 id) {
        id = nextId++;

        uint256 total = principal + (principal * aprBps) / 10_000;
        uint256 per = total / installments;

        agreements[id] = Agreement({
            agent: agent,
            merchant: merchant,
            principal: principal,
            installmentAmount: per,
            installments: installments,
            paid: 0,
            aprBps: aprBps,
            collateralBps: collateralBps,
            cadence: cadence,
            nextDueAt: uint64(block.timestamp) + cadence,
            status: Status.Active
        });
        agreementsOf[agent].push(id);

        _mint(agent, id);
        pool.fundPurchase(merchant, principal, id);

        emit AgreementOpened(id, agent, merchant, principal, installments, collateralBps);
    }

    /// @notice Pay the next installment. Anyone may pay -- the agent, its
    /// principal, or a keeper topping it up.
    function pay(uint256 id) external {
        Agreement storage a = agreements[id];
        if (a.status != Status.Active) revert NotActive();

        bool onTime = block.timestamp <= a.nextDueAt + graceSeconds;
        uint256 amount = a.installmentAmount;

        asset.transferFrom(msg.sender, address(pool), amount);

        a.paid += 1;
        a.nextDueAt = uint64(block.timestamp) + a.cadence;

        uint256 principalPortion = a.principal / a.installments;
        pool.recordRepayment(id, amount, principalPortion);
        score.recordRepayment(a.agent, amount, onTime);

        emit InstallmentPaid(id, a.paid, amount, onTime);

        if (a.paid >= a.installments) {
            a.status = Status.Settled;
            emit AgreementSettled(id);
        }
    }

    /// @notice Callable by anyone once the grace window lapses. Permissionless
    /// on purpose: delinquency should not depend on the lender showing up.
    function markDelinquent(uint256 id) external {
        Agreement storage a = agreements[id];
        if (a.status != Status.Active) revert NotActive();
        if (block.timestamp <= a.nextDueAt + graceSeconds) revert NotDue();

        a.status = Status.Delinquent;
        uint256 outstanding = outstandingOf(id);

        score.recordDefault(a.agent);
        pool.realizeLoss(id, outstanding);

        emit AgreementDelinquent(id, a.agent, outstanding);
    }

    function outstandingOf(uint256 id) public view returns (uint256) {
        Agreement memory a = agreements[id];
        uint16 remaining = a.installments - a.paid;
        return uint256(remaining) * a.installmentAmount;
    }

    function idsOf(address agent) external view returns (uint256[] memory) {
        return agreementsOf[agent];
    }

    /// @dev Struct getters over the public mapping are brittle to field order.
    /// The keeper and dashboard read through these instead.
    function agreementOf(uint256 id) external view returns (Agreement memory) {
        return agreements[id];
    }

    function statusOf(uint256 id) external view returns (Status) {
        return agreements[id].status;
    }

    /// @notice True once the grace window has lapsed on an active agreement.
    /// The keeper polls this rather than recomputing the deadline off-chain.
    function isDelinquent(uint256 id) external view returns (bool) {
        Agreement memory a = agreements[id];
        return a.status == Status.Active && block.timestamp > a.nextDueAt + graceSeconds;
    }

    // --- ERC-721 surface ---

    function _mint(address to, uint256 id) private {
        ownerOf[id] = to;
        unchecked {
            balanceOf[to] += 1;
        }
        emit Transfer(address(0), to, id);
    }

    function approve(address spender, uint256 id) external {
        address o = ownerOf[id];
        if (msg.sender != o && !isApprovedForAll[o][msg.sender]) revert NotOwnerOrApproved();
        getApproved[id] = spender;
        emit Approval(o, spender, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        if (from != ownerOf[id]) revert NotOwnerOrApproved();
        if (
            msg.sender != from && msg.sender != getApproved[id]
                && !isApprovedForAll[from][msg.sender]
        ) revert NotOwnerOrApproved();

        delete getApproved[id];
        unchecked {
            balanceOf[from] -= 1;
            balanceOf[to] += 1;
        }
        ownerOf[id] = to;
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd; // ERC165, ERC721
    }
}
