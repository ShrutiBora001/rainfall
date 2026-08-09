import Anthropic from '@anthropic-ai/sdk';
import { anthropic } from './client.js';
import {
  catalog,
  addressForMerchant,
  MCCS,
  type CatalogItem,
} from '../core/catalog.js';

/**
 * The merchandiser agent.
 *
 * The buyer agent can only buy what a merchant stocks, and a fixed three-item
 * catalogue makes that a toy. This agent stocks the shelf: given a shopper's
 * request it invents a plausible product, prices it, assigns a merchant, and
 * writes it into the catalogue, where the buyer agent can then transact against
 * it exactly like a seeded item.
 *
 * Two constraints are deliberate:
 *
 *   The MCC is chosen from a fixed list of real codes rather than generated.
 *   Rain scopes a card by merchant category, so a hallucinated code produces a
 *   card that declines at the terminal -- the one field here that is
 *   load-bearing rather than decorative.
 *
 *   Products and merchants must be fictional. This storefront gets
 *   screenshotted; inventing "Sony" or "Best Buy" would put a real company's
 *   name on a demo they have nothing to do with.
 */

const MODEL = 'claude-opus-5';

const SYSTEM = `You are the merchandiser for an online store that sells durable consumer goods on installment credit.

A shopper has asked for something the store does not stock. Add one product that satisfies the request.

Rules:
- Invent fictional brands and merchant names. Never use a real company's name or a real product name.
- Price realistically for the item, in US cents, between $50 and $3,000.
- Choose the merchant category code from the provided list that genuinely matches the product.
- Reuse an existing merchant name when the product plausibly belongs in that shop; otherwise invent one.
- The sku is a short lowercase single word, no spaces.
- Pick one emoji that depicts the product.`;

const schema = {
  type: 'object',
  properties: {
    sku: { type: 'string', description: 'short lowercase identifier, one word' },
    label: { type: 'string', description: 'fictional product name' },
    blurb: { type: 'string', description: 'one line of specs, separated by ·' },
    cents: { type: 'integer', description: 'price in US cents' },
    merchant: { type: 'string', description: 'fictional shop name' },
    mcc: { type: 'string', enum: MCCS.map((m) => m.code) },
    art: { type: 'string', description: 'a single emoji' },
  },
  required: ['sku', 'label', 'blurb', 'cents', 'merchant', 'mcc', 'art'],
  additionalProperties: false,
} as const;

export interface SourcedItem {
  item: CatalogItem;
  costUsd: number;
}

export async function sourceItem(request: string): Promise<SourcedItem> {
  const client = anthropic();
  const existing = catalog
    .list()
    .map((i) => `${i.label} (${i.merchant}, MCC ${i.mcc}, $${(i.cents / 100).toFixed(2)})`)
    .join('\n');

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema },
    },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `Shopper's request: ${request}\n\n` +
          `Merchant category codes:\n` +
          MCCS.map((m) => `  ${m.code} — ${m.label}`).join('\n') +
          `\n\nAlready stocked:\n${existing}`,
      },
    ],
  });

  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) throw new Error('merchandiser returned no product');
  const p = JSON.parse(text) as {
    sku: string;
    label: string;
    blurb: string;
    cents: number;
    merchant: string;
    mcc: string;
    art: string;
  };

  const sku = p.sku.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'item';
  const mcc = MCCS.find((m) => m.code === p.mcc) ?? MCCS[0];

  const item: CatalogItem = {
    sku: catalog.find(sku) ? `${sku}${Date.now() % 1000}` : sku,
    label: p.label,
    blurb: p.blurb,
    // Clamp rather than trust: a mispriced item would silently break the
    // underwriting demo by sitting above every credit tier.
    cents: Math.min(Math.max(Math.round(p.cents), 5_000), 300_000),
    merchant: p.merchant,
    merchantAddress: addressForMerchant(p.merchant),
    mcc: mcc.code,
    mccLabel: mcc.label,
    art: p.art,
    sourcedAt: Date.now(),
    sourcedFor: request,
  };

  const u = res.usage;
  const costUsd =
    (u.input_tokens * 5 +
      u.output_tokens * 25 +
      (u.cache_creation_input_tokens ?? 0) * 6.25 +
      (u.cache_read_input_tokens ?? 0) * 0.5) /
    1_000_000;

  return { item: catalog.add(item), costUsd };
}
