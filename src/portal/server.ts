import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { RainfallService } from '../core/service.js';
import { Keeper } from '../keeper/index.js';
import { runAgent, runScriptedAgent, agentAvailable } from '../agent/index.js';

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

    if (url.pathname === '/api/state') {
      return json(200, {
        ...(await svc.state()),
        keeper: { active: keeper.active, autopay: keeper.autopay, intervalMs: keeper.intervalMs },
        // NOT `agent` — that key is the agent's address, from svc.state().
        agentRuntime: { live: agentLive, busy: agentBusy },
      });
    }

    if (url.pathname === '/api/setup') {
      await svc.setup();
      return json(200, { ok: true });
    }

    if (url.pathname === '/api/buy') {
      return json(200, await svc.buy(url.searchParams.get('sku') ?? 'phone'));
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
      agentBusy = true;
      try {
        const out = agentLive
          ? await runAgent(svc, goal)
          : await runScriptedAgent(svc, url.searchParams.get('sku') ?? 'phone');
        return json(200, { ...out, scripted: !agentLive });
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
  agentLive = await agentAvailable();
  console.log(`  agent  ${agentLive ? 'claude-opus-5 (live)' : 'scripted fallback (no API access)'}`);
});
