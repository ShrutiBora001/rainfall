import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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
} from '../chain/contracts.js';
import { MockRails } from '../rails/mock.js';
import { RainRails } from '../rails/rain.js';
import type { CardRails } from '../rails/types.js';

const dep = loadDeployment();
const chain = {
  id: dep.chainId,
  name: dep.label,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [dep.rpc] } },
} as const;

const pub = createPublicClient({ chain, transport: http(dep.rpc) });

// Anvil account 0 by default; overridden by DEPLOYER_PRIVATE_KEY on testnet.
const pk = (process.env.PORTAL_PRIVATE_KEY ??
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain, transport: http(dep.rpc) });

const C = dep.contracts;

/** The agent's own key. Distinct from the principal, who carries the liability. */
const AGENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`;
const PRINCIPAL = account.address;

const CATALOG = {
  phone: { sku: 'phone', label: 'Pixel 9a', cents: 49_900, merchant: 'BestBuy', mcc: '5732' },
  bike: { sku: 'bike', label: 'Aventon Level.3 e-bike', cents: 120_000, merchant: 'CycleWorks', mcc: '5940' },
} as const;
type Sku = keyof typeof CATALOG;

const MERCHANT_ADDR: Record<Sku, `0x${string}`> = {
  phone: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  bike: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
};

const COLLATERAL_ID = process.env.RAIN_COLLATERAL_CONTRACT_ID ?? 'demo-collateral';

const rails: CardRails =
  process.env.RAILS === 'rain'
    ? new RainRails({
        apiKey: process.env.RAIN_API_KEY!,
        baseUrl: process.env.RAIN_BASE_URL,
        collateralContractId: COLLATERAL_ID,
      })
    : new MockRails({ contractId: COLLATERAL_ID, startingCollateralCents: 250_000 });

const log: { at: number; text: string; kind: string }[] = [];
const say = (kind: string, text: string) => {
  log.unshift({ at: Date.now(), text, kind });
  if (log.length > 60) log.pop();
  console.log(`[${kind}] ${text}`);
};

const cards = new Map<number, string>(); // agreementId -> Rain card id

// ---- chain helpers ----

const score = getContract({ address: C.CreditScore, abi: creditScoreAbi, client: pub });
const uw = getContract({ address: C.Underwriter, abi: underwriterAbi, client: pub });
const agr = getContract({ address: C.InstallmentAgreement, abi: agreementAbi, client: pub });
const pool = getContract({ address: C.LiquidityPool, abi: poolAbi, client: pub });

async function readState() {
  const [bps, limit, sc, rec, nextId, poolAssets, deployed] = await Promise.all([
    score.read.requiredCollateralBps([AGENT]),
    score.read.creditLimit([AGENT]),
    score.read.scoreOf([AGENT]),
    score.read.recordOf([AGENT]),
    agr.read.nextId(),
    pool.read.totalAssets(),
    pool.read.deployed(),
  ]);

  const ids = Array.from({ length: Number(nextId) - 1 }, (_, i) => BigInt(i + 1));
  const agreements = await Promise.all(
    ids.map(async (id) => {
      const a = await agr.read.agreementOf([id]);
      const delinquent = await agr.read.isDelinquent([id]);
      return {
        id: Number(id),
        merchant: a.merchant,
        principal: a.principal.toString(),
        installmentAmount: a.installmentAmount.toString(),
        installments: a.installments,
        paid: a.paid,
        collateralBps: a.collateralBps,
        nextDueAt: Number(a.nextDueAt),
        status: ['None', 'Active', 'Settled', 'Delinquent'][a.status],
        overdue: delinquent,
        cardId: cards.get(Number(id)) ?? null,
      };
    }),
  );

  const collateral = await rails.getCollateral(COLLATERAL_ID).catch(() => null);
  const block = await pub.getBlock();

  const quotes: Record<string, unknown> = {};
  for (const k of Object.keys(CATALOG) as Sku[]) {
    const a = await uw.read.assess([AGENT, centsToUnits(CATALOG[k].cents)]);
    quotes[k] = {
      ...CATALOG[k],
      approved: a.approved,
      reason: a.reason,
      requiredCollateralBps: a.requiredCollateralBps,
      installments: a.installments,
      aprBps: a.aprBps,
    };
  }

  return {
    now: Number(block.timestamp),
    agent: AGENT,
    principal: PRINCIPAL,
    deployment: { label: dep.label, chainId: dep.chainId },
    rails: process.env.RAILS === 'rain' ? 'rain' : 'mock',
    credit: {
      score: sc,
      requiredCollateralBps: bps,
      creditLimit: limit.toString(),
      onTime: rec.onTime,
      late: rec.late,
      defaults: rec.defaults,
      totalRepaid: rec.totalRepaid.toString(),
    },
    collateral,
    pool: { totalAssets: poolAssets.toString(), deployed: deployed.toString() },
    agreements,
    quotes,
    log,
  };
}

async function send(address: `0x${string}`, abi: any, fn: string, args: unknown[]) {
  const hash = await wallet.writeContract({ address, abi, functionName: fn, args } as any);
  return pub.waitForTransactionReceipt({ hash });
}

// ---- demo actions ----

async function setup() {
  const registered = await pub.readContract({
    address: C.AgentRegistry,
    abi: registryAbi,
    functionName: 'principalOf',
    args: [AGENT],
  });
  if (registered !== '0x0000000000000000000000000000000000000000') {
    say('info', 'agent already registered');
    return;
  }
  await send(C.AgentRegistry, registryAbi, 'register', [
    AGENT,
    PRINCIPAL,
    `0x${'11'.repeat(32)}`,
  ]);
  // Fund the agent so it can actually repay, and let the agreement pull from it.
  await send(C.MockUSDC, erc20Abi, 'mint', [PRINCIPAL, centsToUnits(2_000_000)]);
  await send(C.MockUSDC, erc20Abi, 'approve', [C.InstallmentAgreement, centsToUnits(9_000_000)]);
  await rails.setRequiredCollateral(COLLATERAL_ID, 10_000).catch(() => {});
  say('ok', `agent ${AGENT.slice(0, 8)} registered, principal funded`);
}

async function buy(sku: Sku) {
  const item = CATALOG[sku];
  const amount = centsToUnits(item.cents);

  const a = await uw.read.assess([AGENT, amount]);
  if (!a.approved) {
    say('decline', `${item.label} declined — ${a.reason}`);
    return { approved: false, reason: a.reason };
  }

  // Rain issues a card scoped to this merchant, this amount, short expiry.
  const card = await rails.issueScopedCard({
    merchant: item.merchant,
    mcc: item.mcc,
    amountCents: item.cents,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    agentId: AGENT,
  });
  say('card', `Rain card ${card.last4} scoped to ${item.merchant} for $${(item.cents / 100).toFixed(2)}`);

  const receipt = await send(C.Underwriter, underwriterAbi, 'authorize', [
    AGENT,
    MERCHANT_ADDR[sku],
    amount,
  ]);
  const id = Number(await agr.read.nextId()) - 1;
  cards.set(id, card.cardId);

  say(
    'ok',
    `#${id} opened — ${item.label}, ${a.installments} installments, ${a.requiredCollateralBps / 100}% collateral (block ${receipt.blockNumber})`,
  );
  await applyCollateral();
  return { approved: true, id };
}

async function pay(id: number) {
  await send(C.InstallmentAgreement, agreementAbi, 'pay', [BigInt(id)]);
  const a = await agr.read.agreementOf([BigInt(id)]);
  say('pay', `#${id} installment ${a.paid}/${a.installments} paid`);
  await applyCollateral();
}

/** Push the ladder's current ratio to Rain. This is where credit becomes cash. */
async function applyCollateral() {
  const bps = await score.read.requiredCollateralBps([AGENT]);
  try {
    await rails.setRequiredCollateral(COLLATERAL_ID, bps);
    say('collateral', `required collateral now ${bps / 100}% — Rain updated`);
  } catch (e) {
    say('warn', `collateral update failed: ${(e as Error).message}`);
  }
}

/** Jump past the due date so delinquency can be shown on cue. */
async function forceMiss(id: number) {
  const grace = await agr.read.graceSeconds();
  const a = await agr.read.agreementOf([BigInt(id)]);
  const now = (await pub.getBlock()).timestamp;
  const jump = Number(a.nextDueAt) + Number(grace) - Number(now) + 5;

  if (dep.chainId === 31337 && jump > 0) {
    await fetch(dep.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_increaseTime', params: [jump] }),
    });
    await fetch(dep.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'evm_mine', params: [] }),
    });
  }

  const outstanding = await agr.read.outstandingOf([BigInt(id)]);
  await send(C.InstallmentAgreement, agreementAbi, 'markDelinquent', [BigInt(id)]);
  say('default', `#${id} DELINQUENT — credit revoked`);

  // Claim what collateral there is. If the agent had climbed to 0%, there is
  // nothing to seize and the pool eats the loss -- which is the honest
  // economics of uncollateralized lending, and worth saying out loud rather
  // than papering over with a reassuring log line.
  const before = await rails.getCollateral(COLLATERAL_ID).catch(() => null);
  const owedCents = Number(outstanding / 10_000n);
  const claimable = Math.min(before?.lockedCents ?? 0, owedCents);
  if (claimable > 0) {
    await rails.claimCollateral(COLLATERAL_ID, claimable);
    say('claim', `$${(claimable / 100).toLocaleString()} collateral claimed from Rain`);
    if (owedCents > claimable) {
      say('loss', `$${((owedCents - claimable) / 100).toLocaleString()} unsecured — pool absorbs it`);
    }
  } else {
    say('loss', `no collateral to claim — $${(owedCents / 100).toLocaleString()} unsecured, pool absorbs it`);
  }

  const cardId = cards.get(id);
  if (cardId) {
    await rails.freezeCard(cardId);
    say('freeze', `Rain card frozen for agreement #${id}`);
  }
  await applyCollateral();
}

// ---- http ----

const html = () =>
  readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html());
    }
    if (url.pathname === '/api/state') return json(200, await readState());
    if (url.pathname === '/api/setup') {
      await setup();
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/buy') {
      const sku = (url.searchParams.get('sku') ?? 'phone') as Sku;
      return json(200, await buy(sku));
    }
    if (url.pathname === '/api/pay') {
      await pay(Number(url.searchParams.get('id')));
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/miss') {
      await forceMiss(Number(url.searchParams.get('id')));
      return json(200, { ok: true });
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    say('error', (e as Error).message.split('\n')[0]);
    json(500, { error: (e as Error).message });
  }
});

const PORT = Number(process.env.PORT ?? 5173);
server.listen(PORT, () => {
  console.log(`Rainfall portal  http://localhost:${PORT}`);
  console.log(`  chain  ${dep.label} (${dep.chainId})`);
  console.log(`  rails  ${process.env.RAILS === 'rain' ? 'rain (live)' : 'mock'}`);
});
