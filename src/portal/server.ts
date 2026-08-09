import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { RainfallService } from '../core/service.js';
import { Keeper } from '../keeper/index.js';
import { runAgent, runScriptedAgent, agentAvailable } from '../agent/index.js';
import { sourceItem } from '../agent/merchandiser.js';
import { catalog } from '../core/catalog.js';

/**
 * Thin HTTP surface. All behavior lives in RainfallService -- this file only
 * translates requests into calls and serves the page.
 */
const svc = new RainfallService();
const keeper = new Keeper(svc, {
  intervalMs: Number(process.env.KEEPER_INTERVAL_MS ?? 5_000),
  autopay: true,
});

let agentLive = false;
let agentBusy = false;

const page = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page('index.html'));
    }

    if (url.pathname === '/shop') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page('shop.html'));
    }

    if (url.pathname === '/api/shop') return json(200, await svc.storefront());

    // The merchandiser agent stocks the shelf on request.
    if (url.pathname === '/api/source') {
      const q = url.searchParams.get('q');
      if (!q) return json(400, { error: 'describe what you need with ?q=' });
      // Price against what this agent can actually borrow, so the shelf is
      // stocked with things it could plausibly buy today.
      const st = await svc.state();
      const { item, costUsd } = await sourceItem(q, {
        affordableUpToCents: Math.round(Number(st.credit.creditLimit) / 10_000),
      });
      svc.say('stock', `merchandiser added ${item.label} for "${q}"`);
      return json(200, { item, costUsd });
    }

    if (url.pathname === '/api/catalog/reset') {
      catalog.resetToSeed();
      svc.say('stock', 'catalog reset to the seeded three');
      return json(200, { ok: true });
    }

    if (url.pathname === '/api/state') {
      return json(200, {
        ...(await svc.state()),
        keeper: { active: keeper.active, autopay: keeper.autopay, intervalMs: keeper.intervalMs },
        // NOT `agent` — that key is the agent's address, from svc.state().
        agentRuntime: { live: agentLive, busy: agentBusy },
      });
    }

    if (url.pathname === '/api/reset') {
      const r = svc.rotateAgent();
      await svc.setup();
      return json(200, { ok: true, ...r });
    }

    if (url.pathname === '/api/setup') {
      await svc.setup();
      return json(200, { ok: true });
    }

    if (url.pathname === '/checkout') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page('checkout.html'));
    }

    if (url.pathname === '/api/plans') {
      return json(200, await svc.planOptions(url.searchParams.get('sku') ?? 'phone'));
    }

    if (url.pathname === '/api/buy') {
      const n = url.searchParams.get('installments');
      return json(
        200,
        await svc.buy(url.searchParams.get('sku') ?? 'phone', n ? Number(n) : undefined),
      );
    }

    if (url.pathname === '/api/onboarding') return json(200, await svc.onboarding());

    if (url.pathname === '/api/schedule') {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isFinite(id) || id < 1) return json(400, { error: 'bad id' });
      const sched = await svc.schedule(id);
      // An id that never existed reads back as an empty struct rather than
      // reverting, so check rather than returning a schedule full of zeroes.
      if (!sched.installments) return json(404, { error: `no obligation #${id}` });
      return json(200, sched);
    }

    if (url.pathname === '/api/payoff') {
      await svc.payoff(Number(url.searchParams.get('id')));
      return json(200, { ok: true });
    }

    if (url.pathname === '/api/pay') {
      await svc.pay(Number(url.searchParams.get('id')));
      return json(200, { ok: true });
    }

    if (url.pathname === '/api/miss') {
      const id = Number(url.searchParams.get('id'));
      await svc.fastForward(id);
      await svc.markDelinquent(id);
      return json(200, { ok: true });
    }

    // ---- agent ----
    if (url.pathname === '/api/agent') {
      if (agentBusy) return json(409, { error: 'agent already running' });
      const goal =
        url.searchParams.get('goal') ??
        'You need a phone for a new hire. Find one, check what credit terms you can get, and buy it if the terms are acceptable.';
      const n = url.searchParams.get('installments');
      const sku = url.searchParams.get('sku') ?? 'phone';
      agentBusy = true;
      try {
        // Always attempt the real agent. A transient network failure must not
        // strand the process on the scripted path for the rest of its life --
        // which is exactly what a one-shot startup probe did.
        try {
          const out = await runAgent(svc, goal);
          agentLive = true;
          return json(200, { ...out, scripted: false });
        } catch (e) {
          const why = (e as Error).message.split('\n')[0];
          agentLive = false;
          svc.say('warn', `live agent unavailable (${why}) — using scripted fallback`);
          const out = await runScriptedAgent(svc, sku, n ? Number(n) : undefined);
          return json(200, { ...out, scripted: true, fallbackReason: why });
        }
      } finally {
        agentBusy = false;
      }
    }

    // ---- keeper ----
    if (url.pathname === '/api/keeper/start') {
      keeper.start();
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/keeper/stop') {
      keeper.stop();
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/keeper/autopay') {
      keeper.autopay = url.searchParams.get('on') !== 'false';
      svc.say('keeper', `autopay ${keeper.autopay ? 'on' : 'off'}`);
      return json(200, { autopay: keeper.autopay });
    }
    if (url.pathname === '/api/keeper/sweep') {
      await keeper.sweep();
      return json(200, { ok: true });
    }

    res.writeHead(404).end('not found');
  } catch (e) {
    svc.say('error', (e as Error).message.split('\n')[0]);
    json(500, { error: (e as Error).message });
  }
});

const PORT = Number(process.env.PORT ?? 5173);
server.listen(PORT, async () => {
  console.log(`Rainfall portal  http://localhost:${PORT}`);
  console.log(`  chain  ${svc.dep.label} (${svc.dep.chainId})`);
  console.log(`  rails  ${svc.railsMode}`);
  // Informational only. The real decision is made per-request, so a failed
  // probe here never locks the session into the scripted path.
  agentLive = await agentAvailable();
  console.log(
    `  agent  ${
      agentLive
        ? 'claude-opus-5 (live)'
        : 'probe failed — will retry live on first run, scripted only if it fails again'
    }`,
  );
});
