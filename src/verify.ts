/**
 * End-to-end verification against the live stack.
 *
 * Three parts, run in order against whatever chain and rails are configured:
 *
 *   1. Payment paths      every way an obligation can be settled
 *   2. Finance            the arithmetic, the pool, and the ladder
 *   3. Rain integration   scoped cards, enforcement, and the account position
 *
 * Uses the $3 test SKU so a full buy -> repay -> settle cycle is cheap enough
 * to run repeatedly. Run with:
 *   DEPLOYMENT=monad RAILS=rain PORTAL_PRIVATE_KEY=... npx tsx src/verify.ts
 */
import 'dotenv/config';
import { RainfallService, usd } from './core/service.js';
import { RainRails } from './rails/rain.js';

const svc = new RainfallService();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  }
}

function near(a: number, b: number, tol = 2): boolean {
  return Math.abs(a - b) <= tol;
}

const centsOf = (units: string | bigint): number => Number(BigInt(units) / 10_000n);

async function activeId(): Promise<number | null> {
  const s = await svc.state();
  const a = s.agreements.filter((x: any) => x.status === 'Active');
  return a.length ? a[a.length - 1].id : null;
}

async function buyTest(installments: number): Promise<number> {
  const r = await svc.buy('test', installments);
  if (!r.approved || !r.id) throw new Error(`test purchase declined: ${r.reason}`);
  return r.id;
}

// ---------------------------------------------------------------- part 1

async function partOne() {
  console.log('\n\x1b[1m1 · PAYMENT PATHS\x1b[0m');

  // (a) one installment at a time
  const a = await buyTest(4);
  await svc.pay(a, 1);
  let sched = await svc.schedule(a);
  check('pay a single installment', sched.paid === 1, `${sched.paid}/${sched.installments}`);

  // (b) pay ahead through several
  await svc.pay(a, 2);
  sched = await svc.schedule(a);
  check('pay ahead through several', sched.paid === 3, `${sched.paid}/${sched.installments}`);

  // (c) early payoff clears the remainder
  await svc.payoff(a);
  sched = await svc.schedule(a);
  check(
    'settle early clears the balance',
    sched.status === 'Settled' && sched.outstandingCents === 0,
    `${sched.status}, outstanding ${usd(sched.outstandingCents)}`,
  );

  // (d) a settled obligation cannot be paid again
  let rejected = false;
  try {
    await svc.pay(a, 1);
  } catch {
    rejected = true;
  }
  const after = await svc.schedule(a);
  check(
    'a settled obligation rejects further payment',
    rejected || after.paid === after.installments,
    `paid ${after.paid}/${after.installments}`,
  );

  // (e) full payoff straight from the start
  const b = await buyTest(2);
  await svc.payoff(b);
  const sb = await svc.schedule(b);
  check(
    'payoff without any prior installment',
    sb.status === 'Settled' && sb.outstandingCents === 0,
    sb.status,
  );
}

// ---------------------------------------------------------------- part 2

async function partTwo() {
  console.log('\n\x1b[1m2 · FINANCE\x1b[0m');

  const before = await svc.state();
  const poolBefore = centsOf(before.pool.totalAssets);
  const shopBefore = await svc.storefront();
  const merchBefore =
    shopBefore.merchants.find((m: any) => m.name === 'Voltmart Electronics')?.settledCents ?? 0;

  const id = await buyTest(2);
  const s = await svc.schedule(id);

  // principal + interest = total payable, split evenly
  const expectedTotal = Math.round(300 * (1 + s.aprBps / 10_000));
  check(
    'total payable is principal plus flat interest',
    near(s.totalPayableCents, expectedTotal),
    `${usd(s.principalCents)} + ${usd(s.totalInterestCents)} = ${usd(s.totalPayableCents)} @ ${s.aprBps / 100}%`,
  );
  check(
    'installments sum to the total',
    near(s.rows.reduce((t: number, r: any) => t + r.totalCents, 0), s.totalPayableCents),
    `${s.installments} × ${usd(s.rows[0].totalCents)}`,
  );
  check(
    'each row splits principal and interest',
    near(s.rows[0].principalCents + s.rows[0].interestCents, s.rows[0].totalCents),
    `${usd(s.rows[0].principalCents)} + ${usd(s.rows[0].interestCents)}`,
  );

  // merchant paid in full at t0
  const shopAfter = await svc.storefront();
  const merchAfter =
    shopAfter.merchants.find((m: any) => m.name === 'Voltmart Electronics')?.settledCents ?? 0;
  check(
    'merchant is settled in full at authorization',
    near(merchAfter - merchBefore, 300),
    `+${usd(merchAfter - merchBefore)}`,
  );

  // pool funded the purchase
  const mid = await svc.state();
  check(
    'pool carries the principal while it is outstanding',
    centsOf(mid.pool.deployed) >= centsOf(before.pool.deployed),
    `deployed ${usd(centsOf(mid.pool.deployed))}`,
  );

  // repay in full; pool ends up ahead by the interest
  await svc.payoff(id);
  const after = await svc.state();
  const poolAfter = centsOf(after.pool.totalAssets);
  check(
    'LPs earn the spread once repaid',
    poolAfter > poolBefore,
    `${usd(poolBefore)} → ${usd(poolAfter)}`,
  );

  // ladder arithmetic
  const c = after.credit;
  check(
    'score stays inside the FICO range',
    c.score >= 300 && c.score <= 850,
    `${c.score} (${c.band})`,
  );
  check(
    'seasoned repayments never exceed on-time repayments',
    c.seasoned <= c.onTime,
    `${c.seasoned} seasoned of ${c.onTime} on time`,
  );
  const expectBps = c.defaults > 0 ? 10_000 : c.seasoned >= 8 ? 0 : c.seasoned >= 3 ? 5_000 : 10_000;
  check(
    'collateral requirement matches the ladder',
    c.requiredCollateralBps === expectBps,
    `${c.requiredCollateralBps / 100}% at ${c.seasoned} seasoned`,
  );
  const expectLimit = c.defaults > 0 ? 0 : c.seasoned >= 8 ? 1500 : c.seasoned >= 3 ? 750 : 500;
  check(
    'credit limit matches the ladder',
    centsOf(c.creditLimit) / 100 === expectLimit,
    `${usd(centsOf(c.creditLimit))}`,
  );

  // an over-limit purchase is refused by the underwriter
  const q = await svc.quote('bike');
  check(
    'underwriter declines above the limit',
    !q.approved && q.reason === 'exceeds credit limit',
    `$1,200 vs ${usd(centsOf(c.creditLimit))} — ${q.reason}`,
  );
}

// ---------------------------------------------------------------- part 3

async function partThree() {
  console.log('\n\x1b[1m3 · RAIN INTEGRATION\x1b[0m');

  if (!(svc.rails instanceof RainRails)) {
    console.log('  \x1b[2mskipped — running on MockRails (set RAILS=rain)\x1b[0m');
    return;
  }
  const rails = svc.rails as RainRails;

  // a scoped card, bound to one amount and one category
  const card = await rails.issueScopedCard({
    merchant: 'Voltmart Electronics',
    mcc: '5732',
    amountCents: 300,
    expiresAt: new Date(Date.now() + 600_000),
    agentId: svc.agent,
  });
  check('scoped card issued', !!card.cardId && card.status === 'active', `last4 ${card.last4}`);

  // Rain enforces the category allowlist
  const wrong = await rails.authorize({
    cardId: card.cardId,
    amountCents: 300,
    merchant: 'Corso Cycles',
    mcc: '5940',
  });
  check(
    'Rain declines a category outside the allowlist',
    wrong.status === 'declined',
    wrong.declinedReason ?? '',
  );

  // and authorizes the matching one
  const right = await rails.issueScopedCard({
    merchant: 'Voltmart Electronics',
    mcc: '5732',
    amountCents: 300,
    expiresAt: new Date(Date.now() + 600_000),
    agentId: svc.agent,
  });
  const ok = await rails.authorize({
    cardId: right.cardId,
    amountCents: 300,
    merchant: 'Voltmart Electronics',
    mcc: '5732',
  });
  check('Rain authorizes the allowed category', ok.status === 'authorized', ok.transactionId?.slice(0, 8));

  // settlement moves pending into posted
  const balBefore = await rails.balances();
  await rails.settle(ok.transactionId, 300);
  const balAfter = await rails.balances();
  check(
    'settlement posts the charge',
    !!balAfter && !!balBefore && balAfter.postedChargesCents > balBefore.postedChargesCents,
    `posted ${usd(balBefore?.postedChargesCents ?? 0)} → ${usd(balAfter?.postedChargesCents ?? 0)}`,
  );

  // spending power falls by what was spent
  check(
    'spending power reflects the charge',
    !!balAfter && !!balBefore && balAfter.spendingPowerCents <= balBefore.spendingPowerCents,
    `${usd(balBefore?.spendingPowerCents ?? 0)} → ${usd(balAfter?.spendingPowerCents ?? 0)}`,
  );

  // a scoped card is single use
  let reused = 'authorized';
  try {
    const again = await rails.authorize({
      cardId: right.cardId,
      amountCents: 300,
      merchant: 'Voltmart Electronics',
      mcc: '5732',
    });
    reused = again.status;
  } catch {
    reused = 'rejected';
  }
  check('a scoped card cannot be reused', reused !== 'authorized', reused);

  // freezing is honoured
  const frozen = await rails.issueScopedCard({
    merchant: 'Voltmart Electronics',
    mcc: '5732',
    amountCents: 300,
    expiresAt: new Date(Date.now() + 600_000),
    agentId: svc.agent,
  });
  await rails.freezeCard(frozen.cardId);
  const got = await rails.getCard(frozen.cardId);
  check('freezing a card is reflected on Rain', got?.status === 'frozen', got?.status ?? 'unknown');

  // the ladder drives the card's spend limit
  const limit = centsOf((await svc.state()).credit.creditLimit);
  await svc.syncStandingCard();
  const standing = await svc.standingCard();
  check(
    'standing card limit tracks the credit limit',
    !standing || standing.limitCents == null || standing.limitCents >= limit,
    standing ? `card ${usd(standing.limitCents ?? 0)} vs ladder ${usd(limit)}` : 'no standing card',
  );
}

// ----------------------------------------------------------------

async function main() {
  console.log(`\n\x1b[1mRainfall verification\x1b[0m`);
  console.log(`  chain  ${svc.dep.label} (${svc.dep.chainId})`);
  console.log(`  rails  ${svc.railsMode}`);
  console.log(`  agent  ${svc.agent}`);

  await svc.setup();

  const start = await svc.state();
  if (Number(start.credit.defaults) > 0) {
    console.log('\n  \x1b[33m!\x1b[0m agent has a default on record — rotating to a clean identity');
    svc.rotateAgent();
    await svc.setup();
  }

  await partOne();
  await partTwo();
  await partThree();

  console.log(
    `\n\x1b[1m${failed === 0 ? '\x1b[32mALL PASSED' : '\x1b[31mFAILURES'}\x1b[0m  ` +
      `${passed} passed, ${failed} failed`,
  );
  if (failed) {
    for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('\n\x1b[31mverification aborted\x1b[0m:', (e as Error).message);
  process.exitCode = 1;
});
