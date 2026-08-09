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
      // viem only batches reads if it knows where Multicall3 is. Without this
      // the `batch.multicall` option below silently does nothing and every
      // read goes out as its own eth_call. Deployed at the canonical address
      // on both Monad and anvil.
      contracts: {
        multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as const },
      },
    } as const;

    // A public RPC will not tolerate the read burst `state()` produces — a
    // dozen-plus eth_calls every poll. Multicall3 is deployed on Monad at the
    // canonical address, so batch them into one request instead.
    this.pub = createPublicClient({
      chain,
      transport: http(this.dep.rpc, { batch: true }),
      // A wider window groups more reads into one multicall. The public Monad
      // RPC caps at 15 requests/sec, and `state()` alone issues more than that.
      batch: { multicall: { wait: 60 } },
    });

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
            userId: process.env.RAIN_USER_ID!,
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

    // Put the principal's collateral behind the account. On live Rain this
    // raises the account's own credit limit by the deposited amount.
    try {
      // Funding is cumulative on Rain and we cannot read the collateral balance
      // back (403), so re-running setup would inflate the account's credit
      // limit on every rehearsal. Use the limit itself as the idempotency
      // check: past the funded threshold, the collateral is already there.
      const before = await this.rails.balances();
      const FUNDED_AT = 1_250_000; // base 1,000,000 + one 250,000 deposit

      if (before && before.creditLimitCents >= FUNDED_AT) {
        this.say(
          'collateral',
          `collateral already funded on Rain — credit limit ${usd(before.creditLimitCents)}`,
        );
      } else {
        await this.rails.fundCollateral(this.collateralId, 250_000);
        const after = await this.rails.balances();
        this.say(
          'collateral',
          after
            ? `$2,500 collateral funded on Rain — credit limit now ${usd(after.creditLimitCents)}`
            : `$2,500 collateral funded on Rain`,
        );
      }
    } catch (e) {
      this.say('warn', `collateral funding unavailable: ${(e as Error).message}`);
    }

    await this.ensureStandingCard();
    this.say('ok', `agent ${this.agent.slice(0, 8)} registered, principal funded`);
  }

  /** The underwriting decision, read straight off Monad. */
  async quote(sku: string) {
    const item = findItem(sku);
    if (!item) throw new Error(`unknown sku: ${sku}`);
    const a = await this.uw.read.assess([this.agent, centsToUnits(item.cents)]);
    return { item, ...a };
  }

  /**
   * Plan options for checkout. The underwriter decides *whether* credit is
   * extended; the buyer picks the term. Both matter, and they are separate
   * questions -- stretching a plan never makes an over-limit purchase clear.
   */
  async planOptions(sku: string) {
    const item = findItem(sku);
    if (!item) throw new Error(`unknown sku: ${sku}`);
    const a = await this.uw.read.assess([this.agent, centsToUnits(item.cents)]);
    const total = Math.round(item.cents * (1 + a.aprBps / 10_000));
    return {
      item,
      approved: a.approved,
      reason: a.reason,
      requiredCollateralBps: a.requiredCollateralBps,
      aprBps: a.aprBps,
      creditLimitCents: Number(a.creditLimit / 10_000n),
      plans: [2, 3, 4, 6].map((n) => ({
        installments: n,
        perInstallmentCents: Math.round(total / n),
        totalCents: total,
        interestCents: total - item.cents,
      })),
    };
  }

  async buy(
    sku: string,
    installments?: number,
  ): Promise<{ approved: boolean; id?: number; reason: string }> {
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

    // Run it through the card network. Rain applies its own limits and MCC
    // rules here and can decline independently of our underwriter -- two
    // separate gates, which is exactly how a real card program behaves.
    try {
      const auth = await this.rails.authorize({
        cardId: card.cardId,
        amountCents: item.cents,
        merchant: item.merchant,
        mcc: item.mcc,
      });
      if (auth.status !== 'authorized') {
        this.say('decline', `Rain declined the authorization — ${auth.declinedReason}`);
        return { approved: false, reason: `card declined: ${auth.declinedReason}` };
      }
      this.say('auth', `Rain authorized ${usd(item.cents)} · tx ${auth.transactionId.slice(0, 8)}`);
      await this.rails.settle(auth.transactionId, item.cents);
      this.say('settle', `authorization settled — posted to the account`);
    } catch (e) {
      this.say('warn', `authorization step skipped: ${(e as Error).message}`);
    }

    const receipt = installments
      ? await this.send(this.dep.contracts.Underwriter, underwriterAbi, 'authorizeWithPlan', [
          this.agent,
          item.merchantAddress,
          amount,
          installments,
        ])
      : await this.send(this.dep.contracts.Underwriter, underwriterAbi, 'authorize', [
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
      // Expected on live Rain: the collateral routes are 403 for this key. The
      // ratio is authoritative on Monad either way; only the mirror is missing.
      const msg = (e as Error).message;
      this.say(
        'collateral',
        msg.includes('403')
          ? `required collateral now ${bps / 100}% — mirrored on Monad (Rain collateral scope unavailable)`
          : `collateral update failed: ${msg}`,
      );
    }
    await this.syncStandingCard();
  }

  /**
   * The half of the ladder that genuinely executes on Rain. Collateral is
   * gated, but the card's spend ceiling is not -- so as standing rises on
   * Monad, the amount this agent's card may authorize rises with it, on Rain's
   * own infrastructure. Verifiable with a GET against their API.
   */
  private standingCardId: string | null = null;

  async ensureStandingCard(): Promise<string | null> {
    if (this.standingCardId) return this.standingCardId;
    try {
      const limit = await this.score.read.creditLimit([this.agent]);
      const card = await this.rails.issueScopedCard({
        merchant: 'rainfall-standing',
        mcc: '0000',
        amountCents: Number(limit / 10_000n),
        expiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
        agentId: this.agent,
      });
      this.standingCardId = card.cardId;
      this.say('card', `standing card ${card.last4} issued — limit tracks the ladder`);
      return card.cardId;
    } catch (e) {
      this.say('warn', `standing card unavailable: ${(e as Error).message}`);
      return null;
    }
  }

  async syncStandingCard(): Promise<void> {
    const id = this.standingCardId;
    if (!id) return;
    const limit = Number((await this.score.read.creditLimit([this.agent])) / 10_000n);
    try {
      await this.rails.setSpendLimit(id, limit);
      this.say('limit', `Rain card spend limit set to ${usd(limit)} — matches the ladder`);
    } catch (e) {
      this.say('warn', `spend limit update failed: ${(e as Error).message}`);
    }
  }

  async standingCard() {
    if (!this.standingCardId) return null;
    return this.rails.getCard(this.standingCardId).catch(() => null);
  }

  /** Settle the remaining balance in one payment. */
  async payoff(id: number): Promise<void> {
    await this.send(this.dep.contracts.InstallmentAgreement, agreementAbi, 'payoff', [
      BigInt(id),
    ]);
    this.say('payoff', `#${id} settled early — full balance cleared`);
    await this.syncCollateral();
  }

  /**
   * The amortization schedule: what a borrower actually signs. Interest here
   * is flat (principal x APR, split evenly) rather than reducing-balance --
   * simpler to verify on-chain, and stated plainly rather than dressed up as
   * something it isn't.
   */
  async schedule(id: number) {
    const a = await this.agr.read.agreementOf([BigInt(id)]);
    const per = Number(a.installmentAmount / 10_000n);
    const principalPer = Math.floor(Number(a.principal / 10_000n) / a.installments);
    const interestPer = per - principalPer;

    const rows = [];
    for (let n = 1; n <= a.installments; n++) {
      // nextDueAt tracks the *unpaid* head of the schedule; earlier rows are
      // back-dated from it and later ones projected forward.
      const dueAt = Number(a.nextDueAt) + (n - 1 - a.paid) * Number(a.cadence);
      rows.push({
        n,
        dueAt,
        totalCents: per,
        principalCents: principalPer,
        interestCents: interestPer,
        status:
          n <= a.paid
            ? 'paid'
            : a.status === 3
              ? 'defaulted'
              : n === a.paid + 1
                ? 'due'
                : 'scheduled',
      });
    }

    return {
      id,
      principalCents: Number(a.principal / 10_000n),
      totalPayableCents: per * a.installments,
      totalInterestCents: interestPer * a.installments,
      aprBps: a.aprBps,
      installments: a.installments,
      paid: a.paid,
      cadenceSeconds: Number(a.cadence),
      outstandingCents: Number((await this.agr.read.outstandingOf([BigInt(id)])) / 10_000n),
      late: await this.agr.read.isLate([BigInt(id)]),
      overdue: await this.agr.read.isDelinquent([BigInt(id)]),
      status: ['None', 'Active', 'Settled', 'Delinquent'][a.status],
      rows,
    };
  }

  /**
   * Origination: who is on the hook before any money moves. Three identity
   * layers -- the Rain user who passed KYC, the principal who posts collateral,
   * and the agent session key that actually transacts.
   */
  async onboarding() {
    const C = this.dep.contracts;
    const registeredTo = (await this.pub.readContract({
      address: C.AgentRegistry,
      abi: registryAbi,
      functionName: 'principalOf',
      args: [this.agent],
    })) as string;
    const registered = registeredTo !== '0x0000000000000000000000000000000000000000';

    let rainUser: unknown = null;
    if (this.railsMode === 'rain' && process.env.RAIN_API_KEY) {
      rainUser = await fetch(
        `${process.env.RAIN_BASE_URL ?? 'https://api-dev.rain.xyz'}/v1/issuing/users`,
        { headers: { 'api-key': process.env.RAIN_API_KEY } },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((u: any) => (Array.isArray(u) ? u[0] : u))
        .catch(() => null);
    }

    return {
      rainUser,
      collateralContractId: this.collateralId,
      collateral: await this.rails.getCollateral(this.collateralId).catch(() => null),
      principal: this.principal,
      agent: this.agent,
      registered,
      registeredTo: registered ? registeredTo : null,
    };
  }

  /** True once the grace window has lapsed -- the keeper's trigger. */
  async isOverdue(id: number): Promise<boolean> {
    return this.agr.read.isDelinquent([BigInt(id)]);
  }

  async activeIds(): Promise<number[]> {
    const next = Number(await this.agr.read.nextId());
    const all = Array.from({ length: next - 1 }, (_, i) => i + 1);
    const statuses = await Promise.all(all.map((i) => this.agr.read.statusOf([BigInt(i)])));
    return all.filter((_, k) => statuses[k] === 1);
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

  /**
   * The portal polls this on a timer and two pages may be open at once. Against
   * a public RPC capped at 15 requests/sec that is enough to rate-limit
   * ourselves, so serve a briefly cached snapshot and coalesce concurrent
   * callers onto one in-flight read.
   */
  private stateCache: { at: number; data: unknown } | null = null;
  private stateInFlight: Promise<any> | null = null;
  /** Local anvil can be polled hard; a public RPC cannot. */
  private get stateTtlMs(): number {
    return this.dep.chainId === 31337 ? 250 : 1500;
  }

  async state(): Promise<any> {
    const now = Date.now();
    if (this.stateCache && now - this.stateCache.at < this.stateTtlMs) {
      return this.stateCache.data;
    }
    if (this.stateInFlight) return this.stateInFlight;
    this.stateInFlight = this.readState()
      .then((d) => {
        this.stateCache = { at: Date.now(), data: d };
        return d;
      })
      .finally(() => {
        this.stateInFlight = null;
      });
    return this.stateInFlight;
  }

  private async readState() {
    const [bps, limit, sc, rec, nextId, poolAssets, deployed, toNextTier, seasoning] =
      await Promise.all([
        this.score.read.requiredCollateralBps([this.agent]),
        this.score.read.creditLimit([this.agent]),
        this.score.read.scoreOf([this.agent]),
        this.score.read.recordOf([this.agent]),
        this.agr.read.nextId(),
        this.pool.read.totalAssets(),
        this.pool.read.deployed(),
        this.score.read.nextTierIn([this.agent]),
        this.score.read.seasoningPeriod(),
      ]);

    // Every read below must be issued concurrently or multicall has nothing to
    // batch -- sequential awaits become sequential eth_calls, which is what
    // rate-limits a public RPC.
    const ids = Array.from({ length: Number(nextId) - 1 }, (_, i) => i + 1);
    const agreements = await Promise.all(
      ids.map(async (i) => {
        const [a, overdue, late] = await Promise.all([
          this.agr.read.agreementOf([BigInt(i)]),
          this.agr.read.isDelinquent([BigInt(i)]),
          this.agr.read.isLate([BigInt(i)]),
        ]);
        return {
          id: i,
          merchant: a.merchant,
          principal: a.principal.toString(),
          installmentAmount: a.installmentAmount.toString(),
          installments: a.installments,
          paid: a.paid,
          collateralBps: a.collateralBps,
          nextDueAt: Number(a.nextDueAt),
          status: ['None', 'Active', 'Settled', 'Delinquent'][a.status],
          overdue,
          late,
          cardId: this.cards.get(i) ?? null,
        };
      }),
    );

    const items = catalogList();
    const assessed = await Promise.all(
      items.map((item) => this.uw.read.assess([this.agent, centsToUnits(item.cents)])),
    );
    const quotes: Record<string, unknown> = {};
    items.forEach((item, k) => {
      const a = assessed[k];
      quotes[item.sku] = {
        ...item,
        approved: a.approved,
        reason: a.reason,
        requiredCollateralBps: a.requiredCollateralBps,
        installments: a.installments,
        aprBps: a.aprBps,
      };
    });

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
        // Repayments that advanced the ladder, vs raw repayment count. They
        // diverge exactly when someone tries to buy standing in one block.
        seasoned: rec.seasoned,
        toNextTier: toNextTier > 1_000_000 ? null : toNextTier,
        seasoningPeriodSeconds: Number(seasoning),
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
    const orders = s.agreements.map((a: any) => {
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
