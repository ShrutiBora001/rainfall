import { readFileSync } from 'node:fs';
import { parseAbi } from 'viem';

/**
 * Human-readable ABIs rather than build artifacts: the portal should not break
 * because someone ran `forge clean`, and these are short enough to read.
 */
export const creditScoreAbi = parseAbi([
  'function requiredCollateralBps(address agent) view returns (uint16)',
  'function creditLimit(address agent) view returns (uint256)',
  'function scoreOf(address agent) view returns (uint16)',
  'function recordOf(address agent) view returns ((uint32 onTime,uint32 late,uint32 defaults,uint96 totalRepaid,uint16 score))',
  'event RepaymentRecorded(address indexed agent, uint256 amount, bool onTime, uint16 score)',
  'event DefaultRecorded(address indexed agent, uint16 score)',
  'event TierChanged(address indexed agent, uint16 requiredCollateralBps, uint256 creditLimit)',
]);

export const underwriterAbi = parseAbi([
  'function assess(address agent, uint256 amount) view returns ((bool approved,uint16 installments,uint16 aprBps,uint16 requiredCollateralBps,uint256 creditLimit,string reason))',
  'function canAfford(address agent, uint256 amount) view returns (bool)',
  'function authorize(address agent, address merchant, uint256 amount) returns (uint256, (bool,uint16,uint16,uint16,uint256,string))',
  'function setTerms(uint16 installments, uint16 aprBps, uint64 cadence)',
]);

export const agreementAbi = parseAbi([
  'function agreementOf(uint256 id) view returns ((address agent,address merchant,uint256 principal,uint256 installmentAmount,uint16 installments,uint16 paid,uint16 aprBps,uint16 collateralBps,uint64 cadence,uint64 nextDueAt,uint8 status))',
  'function statusOf(uint256 id) view returns (uint8)',
  'function isDelinquent(uint256 id) view returns (bool)',
  'function isLate(uint256 id) view returns (bool)',
  'function payoff(uint256 id)',
  'function idsOf(address agent) view returns (uint256[])',
  'function outstandingOf(uint256 id) view returns (uint256)',
  'function nextId() view returns (uint256)',
  'function pay(uint256 id)',
  'function markDelinquent(uint256 id)',
  'function graceSeconds() view returns (uint64)',
  'event AgreementOpened(uint256 indexed id, address indexed agent, address indexed merchant, uint256 principal, uint16 installments, uint16 collateralBps)',
  'event InstallmentPaid(uint256 indexed id, uint16 number, uint256 amount, bool onTime)',
  'event AgreementSettled(uint256 indexed id)',
  'event AgreementDelinquent(uint256 indexed id, address indexed agent, uint256 outstanding)',
]);

export const registryAbi = parseAbi([
  'function register(address agent, address principal, bytes32 collateralRef)',
  'function principalOf(address agent) view returns (address)',
  'function isActive(address agent) view returns (bool)',
  'function setCardRef(address agent, bytes32 rainCardRef)',
]);

export const poolAbi = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function deployed() view returns (uint256)',
]);

export const erc20Abi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

export interface Deployment {
  chainId: number;
  rpc: string;
  label: string;
  deployer: `0x${string}`;
  contracts: Record<string, `0x${string}`>;
}

export function loadDeployment(name = process.env.DEPLOYMENT ?? 'local'): Deployment {
  const url = new URL(`../../deployments/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Deployment;
}

/** USDC has 6 decimals; off-chain money is integer cents. One conversion, here. */
export const centsToUnits = (cents: number): bigint => BigInt(cents) * 10_000n;
export const unitsToCents = (units: bigint): number => Number(units / 10_000n);
export const fmtUsd = (units: bigint): string =>
  (Number(units) / 1e6).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
