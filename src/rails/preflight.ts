/**
 * Answers one question: can we run the demo on live Rain rails, or do we fall
 * back to MockRails? Run it on arrival, and again after the Rain team touches
 * the key. Everything it checks was established by probing the live API.
 */
import 'dotenv/config';

const BASE = (process.env.RAIN_BASE_URL ?? 'https://api.rain.xyz').replace(/\/$/, '');
const KEY = process.env.RAIN_API_KEY ?? '';
const CONTRACT = process.env.RAIN_COLLATERAL_CONTRACT_ID ?? '';

const HOSTS = [BASE, 'https://api-dev.rain.xyz'];
const ROUTES = ['/v1/cards', '/v1/issuing/cards', '/v1/transactions'];

async function probe(url: string, withKey: boolean) {
  try {
    const res = await fetch(url, {
      headers: withKey ? { 'api-key': KEY, accept: 'application/json' } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    return { status: res.status, body: body.slice(0, 200) };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}

async function main() {
  if (!KEY) {
    console.error('RAIN_API_KEY is unset. Copy .env.example to .env first.');
    process.exit(2);
  }

  console.log('Rainfall preflight\n');
  let anyAuthed = false;

  for (const host of HOSTS) {
    console.log(`── ${host}`);
    for (const route of ROUTES) {
      const r = await probe(`${host}${route}`, true);
      const verdict =
        r.status === 200 ? 'OK — key is live'
        : r.status === 401 ? `rejected: ${r.body}`
        : r.status === 404 ? 'route not found'
        : r.status === 0 ? 'unreachable'
        : `status ${r.status}`;
      if (r.status === 200) anyAuthed = true;
      console.log(`   ${route.padEnd(20)} ${verdict}`);
    }
    console.log();
  }

  if (CONTRACT) {
    // /v1/collateral-contracts is confirmed NOT to be a route. Try the
    // plausible spellings so the real one surfaces the moment it exists.
    console.log('── collateral route discovery');
    for (const p of [
      '/v1/collateral-contracts',
      '/v1/collateral_contracts',
      '/v1/contracts',
      '/v1/collateral',
    ]) {
      const r = await probe(`${BASE}${p}/${CONTRACT}`, true);
      console.log(`   ${p.padEnd(28)} ${r.status || 'unreachable'}`);
    }
    console.log();
  }

  if (anyAuthed) {
    console.log('VERDICT: live rails available. Run the demo with --rails=rain.');
  } else {
    console.log(
      'VERDICT: key not accepted. Run on MockRails.\n' +
        'Ask Rain: (1) sandbox base URL and is this key activated?\n' +
        '          (2) does the sandbox simulate card authorizations?\n' +
        '          (3) is collateral release programmatic or read-only?',
    );
  }
}

main();
