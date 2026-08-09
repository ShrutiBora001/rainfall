import 'dotenv/config';
import { createPublicClient, createWalletClient, http, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  loadDeployment,
  agreementAbi,
  creditScoreAbi,
  underwriterAbi,
  registryAbi,
  poolAbi,
  erc20Abi,
  centsToUnits,
  type Deployment,
} from '../chain/contracts.js';
import { MockRails } from '../rails/mock.js';
import { RainRails } from '../rails/rain.js';
import type { CardRails, Cents } from '../rails/types.js';
import { CATALOG, catalogList, findItem, merchants, type CatalogItem } from './catalog.js';

export interface LogEntry {
  at: number;
  kind: string;
  text: string;
}

/**
 * The single place Rainfall's behavior lives. The portal, the agent, and the
 * keeper are three front-ends onto this object -- none of them may reach past
 * it to the chain or the rails directly, so the three surfaces can never
 * disagree about what a purchase or a default means.
 */
export class RainfallService {
  readonly dep: Deployment;
  readonly rails: CardRails;
  readonly collateralId: string;
  readonly agent: `0x${string}`;
  readonly principal: `0x${string}`;

  private pub;
  private wallet;
  private score;
  private uw;
  private agr;
  private pool;
  private cards = new Map<number, string>();
  private log: LogEntry[] = [];

  constructor(opts: { railsMode?: 'mock' | 'rain' } = {}) {
    this.dep = loadDeployment();
    const chain = {
      id: this.dep.chainId,
      name: this.dep.label,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [this.dep.rpc] } },
    } as const;

    this.pub = createPublicClient({ chain, transport: http(this.dep.rpc) });

    // Anvil account 0 unless overridden. On Monad testnet, set PORTAL_PRIVATE_KEY.
    const pk = (process.env.PORTAL_PRIVATE_KEY ??
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;
    const account = privateKeyToAccount(pk);
    this.wallet = createWalletClient({ account, chain, transport: http(this.dep.rpc) });

    this.principal = account.address;
    // The agent's own key -- deliberately distinct from the principal, who
    // carries the liability.
    this.agent = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

    this.collateralId = process.env.RAIN_COLLATERAL_CONTRACT_ID ?? 'demo-collateral';
    const mode = opts.railsMode ?? (process.env.RAILS === 'rain' ? 'rain' : 'mock');
    this.rails =
      mode === 'rain'
        ? new RainRails({
            apiKey: process.env.RAIN_API_KEY!,
            baseUrl: process.env.RAIN_BASE_URL,
            collateralContractId: this.collateralId,
          })
        : new MockRails({ contractId: this.collateralId, startingCollateralCents: 250_000 });
    this.railsMode = mode;

    const C = this.dep.contracts;
    this.score = getContract({ address: C.CreditScore, abi: creditScoreAbi, client: this.pub });
    this.uw = getContract({ address: C.Underwriter, abi: underwriterAbi, client: this.pub });
    this.agr = getContract({
      address: C.InstallmentAgreement,
      abi: agreementAbi,
      client: this.pub,
    });
    this.pool = getContract({ address: C.LiquidityPool, abi: poolAbi, client: this.pub });
  }

  readonly railsMode: 'mock' | 'rain';

  say(kind: string, text: string) {
    this.log.unshift({ at: Date.now(), kind, text });
    if (this.log.length > 80) this.log.pop();
    console.log(`[${kind}] ${text}`);
  }

  private async send(address: `0x${string}`, abi: any, fn: string, args: unknown[]) {
    const hash = await this.wallet.writeContract({
      address,
      abi,
      functionName: fn,
      args,
    } as any);
    return this.pub.waitForTransactionReceipt({ hash });
  }

  // ---- lifecycle ----

  async setup(): Promise<void> {
    const C = this.dep.contracts;
    const registered = await this.pub.readContract({
      address: C.AgentRegistry,
      abi: registryAbi,
      functionName: 'principalOf',
      args: [this.agent],
    });
    if (registered !== '0x0000000000000000000000000000000000000000') {
      this.say('info', 'agent already registered');
      return;
    }
    await this.send(C.AgentRegistry, registryAbi, 'register', [
      this.agent,
      this.principal,
      `0x${'11'.repeat(32)}`,
    ]);
    await this.send(C.MockUSDC, erc20Abi, 'mint', [this.principal, centsToUnits(2_000_000)]);
    await this.send(C.MockUSDC, erc20Abi, 'approve', [
      C.InstallmentAgreement,
      centsToUnits(9_000_000),
    ]);
    await this.rails.setRequiredCollateral(this.collateralId, 10_000).catch(() => {});
    this.say('ok', `agent ${this.agent.slice(0, 8)} registered, principal funded`);
  }

  /** The underwriting decision, read straight off Monad. */
  async quote(sku: string) {
    const item = findItem(sku);
    if (!item) throw new Error(`unknown sku: ${sku}`);
    const a = await this.uw.read.assess([this.agent, centsToUnits(item.cents)]);
    return { item, ...a };
  }

  async buy(sku: string): Promise<{ approved: boolean; id?: number; reason: string }> {
    const item = findItem(sku);
    if (!item) throw new Error(`unknown sku: ${sku}`);
    const amount = centsToUnits(item.cents);

    const a = await this.uw.read.assess([this.agent, amount]);
    if (!a.approved) {
      this.say('decline', `${item.label} declined — ${a.reason}`);
      return { approved: false, reason: a.reason };
    }

    // Rain issues a card scoped to this merchant, this amount, short expiry.
    const card = await this.rails.issueScopedCard({
      merchant: item.merchant,
      mcc: item.mcc,
      amountCents: item.cents,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      agentId: this.agent,
    });
    this.say(
      'card',
      `Rain card ${card.last4} scoped to ${item.merchant} for ${usd(item.cents)}`,
    );

    const receipt = await this.send(this.dep.contracts.Underwriter, underwriterAbi, 'authorize', [
      this.agent,
      item.merchantAddress,
      amount,
    ]);
    const id = Number(await this.agr.read.nextId()) - 1;
    this.cards.set(id, card.cardId);

    this.say(
      'ok',
      `#${id} opened — ${item.label}, ${a.installments} installments, ` +
        `${a.requiredCollateralBps / 100}% collateral (block ${receipt.blockNumber})`,
    );
    await this.syncCollateral();
    return { approved: true, id, reason: a.reason };
  }

  async pay(id: number): Promise<void> {
    await this.send(this.dep.contracts.InstallmentAgreement, agreementAbi, 'pay', [BigInt(id)]);
    const a = await this.agr.read.agreementOf([BigInt(id)]);
    this.say('pay', `#${id} installment ${a.paid}/${a.installments} paid`);
    await this.syncCollateral();
  }

  /**
   * Push the ladder's current ratio to Rain. This is the step where an
   * abstract credit score turns into the principal's capital being released.
   */
  async syncCollateral(): Promise<void> {
    const bps = await this.score.read.requiredCollateralBps([this.agent]);
    try {
      await this.rails.setRequiredCollateral(this.collateralId, bps);
      this.say('collateral', `required collateral now ${bps / 100}% — Rain updated`);
    } catch (e) {
      this.say('warn', `collateral update failed: ${(e as Error).message}`);
    }
  }

  /** True once the grace window has lapsed -- the keeper's trigger. */
  async isOverdue(id: number): Promise<boolean> {
    return this.agr.read.isDelinquent([BigInt(id)]);
  }

  async activeIds(): Promise<number[]> {
    const next = Number(await this.agr.read.nextId());
    const ids: number[] = [];
    for (let i = 1; i < next; i++) {
      if ((await this.agr.read.statusOf([BigInt(i)])) === 1) ids.push(i);
    }
    return ids;
  }

  /** Jump past the due date so delinquency can be demonstrated on cue. */
  async fastForward(id: number): Promise<void> {
    if (this.dep.chainId !== 31337) return;
    const grace = await this.agr.read.graceSeconds();
    const a = await this.agr.read.agreementOf([BigInt(id)]);
    const now = (await this.pub.getBlock()).timestamp;
    const jump = Number(a.nextDueAt) + Number(grace) - Number(now) + 5;
    if (jump <= 0) return;
    await this.rpc('evm_increaseTime', [jump]);
    await this.rpc('evm_mine', []);
  }

  private async rpc(method: string, params: unknown[]) {
    await fetch(this.dep.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  /**
   * Mark an agreement delinquent, claim what collateral exists, and kill the
   * card. If the agent had climbed to 0% there is nothing to seize and the
   * pool eats the loss -- the honest economics of uncollateralized lending,
   * reported rather than papered over.
   */
  async markDelinquent(id: number): Promise<void> {
    const outstanding = await this.agr.read.outstandingOf([BigInt(id)]);
    await this.send(this.dep.contracts.InstallmentAgreement, agreementAbi, 'markDelinquent', [
      BigInt(id),
    ]);
    this.say('default', `#${id} DELINQUENT — credit revoked`);

    const before = await this.rails.getCollateral(this.collateralId).catch(() => null);
    const owedCents = Number(outstanding / 10_000n);
    const claimable = Math.min(before?.lockedCents ?? 0, owedCents);
    if (claimable > 0) {
      await this.rails.claimCollateral(this.collateralId, claimable);
      this.say('claim', `${usd(claimable)} collateral claimed from Rain`);
      if (owedCents > claimable) {
        this.say('loss', `${usd(owedCents - claimable)} unsecured — pool absorbs it`);
      }
    } else {
      this.say('loss', `no collateral to claim — ${usd(owedCents)} unsecured, pool absorbs it`);
    }

    const cardId = this.cards.get(id);
    if (cardId) {
      await this.rails.freezeCard(cardId);
      this.say('freeze', `Rain card frozen for agreement #${id}`);
    }
    await this.syncCollateral();
  }

  // ---- reads ----

  async state() {
    const [bps, limit, sc, rec, nextId, poolAssets, deployed] = await Promise.all([
      this.score.read.requiredCollateralBps([this.agent]),
      this.score.read.creditLimit([this.agent]),
      this.score.read.scoreOf([this.agent]),
      this.score.read.recordOf([this.agent]),
      this.agr.read.nextId(),
      this.pool.read.totalAssets(),
      this.pool.read.deployed(),
    ]);

    const agreements = [];
    for (let i = 1; i < Number(nextId); i++) {
      const a = await this.agr.read.agreementOf([BigInt(i)]);
      agreements.push({
        id: i,
        merchant: a.merchant,
        principal: a.principal.toString(),
        installmentAmount: a.installmentAmount.toString(),
        installments: a.installments,
        paid: a.paid,
        collateralBps: a.collateralBps,
        nextDueAt: Number(a.nextDueAt),
        status: ['None', 'Active', 'Settled', 'Delinquent'][a.status],
        overdue: await this.agr.read.isDelinquent([BigInt(i)]),
        cardId: this.cards.get(i) ?? null,
      });
    }

    const quotes: Record<string, unknown> = {};
    for (const item of catalogList()) {
      const a = await this.uw.read.assess([this.agent, centsToUnits(item.cents)]);
      quotes[item.sku] = {
        ...item,
        approved: a.approved,
        reason: a.reason,
        requiredCollateralBps: a.requiredCollateralBps,
        installments: a.installments,
        aprBps: a.aprBps,
      };
    }

    return {
      now: Number((await this.pub.getBlock()).timestamp),
      agent: this.agent,
      principal: this.principal,
      deployment: { label: this.dep.label, chainId: this.dep.chainId },
      rails: this.railsMode,
      credit: {
        score: sc,
        requiredCollateralBps: bps,
        creditLimit: limit.toString(),
        onTime: rec.onTime,
        late: rec.late,
        defaults: rec.defaults,
      },
      collateral: await this.rails.getCollateral(this.collateralId).catch(() => null),
      pool: { totalAssets: poolAssets.toString(), deployed: deployed.toString() },
      agreements,
      quotes,
      log: this.log,
    };
  }

  catalog() {
    return catalogList();
  }

  /**
   * The merchant's side of the same transaction. This is the half of BNPL that
   * usually goes unshown: the merchant is settled in full the moment the card
   * authorizes, while the buyer still owes four installments. Two windows side
   * by side make the split legible without a word of explanation.
   */
  async storefront() {
    const balances = await Promise.all(
      merchants().map(async (m) => ({
        ...m,
        settledCents: Number(
          ((await this.pub.readContract({
            address: this.dep.contracts.MockUSDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [m.address],
          })) as bigint) / 10_000n,
        ),
      })),
    );

    const s = await this.state();
    const orders = s.agreements.map((a) => {
      const item = catalogList().find(
        (i) => i.merchantAddress.toLowerCase() === a.merchant.toLowerCase(),
      );
      const total = Number(BigInt(a.installmentAmount) / 10_000n) * a.installments;
      const paid = Number(BigInt(a.installmentAmount) / 10_000n) * a.paid;
      return {
        id: a.id,
        merchant: item?.merchant ?? a.merchant.slice(0, 10),
        item: item?.label ?? 'unknown',
        art: item?.art ?? '📦',
        settledCents: Number(BigInt(a.principal) / 10_000n),
        buyerOwesCents: Math.max(total - paid, 0),
        installments: `${a.paid}/${a.installments}`,
        status: a.status,
      };
    });

    return { merchants: balances, orders, catalog: catalogList() };
  }
}

export const usd = (cents: Cents): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export { CATALOG, type CatalogItem };
