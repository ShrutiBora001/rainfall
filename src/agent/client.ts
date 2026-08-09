import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Build a client that trusts .env over the ambient shell.
 *
 * dotenv never overrides variables already exported, so a stale
 * ANTHROPIC_API_KEY -- or an ANTHROPIC_AUTH_TOKEN left behind by another tool
 * -- silently wins and the key in .env is ignored. Worse, a key and an auth
 * token sent together are rejected outright. Read .env directly and pass the
 * key explicitly so the file is authoritative.
 */
export function anthropic(): Anthropic {
  let apiKey = process.env.ANTHROPIC_API_KEY;
  try {
    const envFile = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    const m = envFile.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (m && m[1].trim()) apiKey = m[1].trim();
  } catch {
    // no .env -- fall back to whatever the environment provides
  }
  return new Anthropic({ apiKey, authToken: null });
}
