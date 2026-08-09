import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cents } from '../rails/types.js';

/**
 * Merchants and products are deliberately fictional. A demo storefront wearing
 * a real retailer's name is impersonating that retailer, and these pages get
 * screenshotted and shared -- the MCCs are the real, load-bearing part.
 */
export interface CatalogItem {
  sku: string;
  label: string;
  blurb: string;
  cents: Cents;
  merchant: string;
  merchantAddress: `0x${string}`;
  mcc: string;
  mccLabel: string;
  art: string;
  /** Set when the merchandiser agent sourced this rather than it being seeded. */
  sourcedAt?: number;
  sourcedFor?: string;
}

/**
 * Real merchant category codes. The merchandiser must choose from these rather
 * than inventing one: the MCC is what Rain scopes a card against, so a
 * hallucinated code would produce a card that declines at the terminal.
 */
export const MCCS: { code: string; label: string }[] = [
  { code: '5732', label: 'consumer electronics' },
  { code: '5940', label: 'bicycle shops' },
  { code: '5571', label: 'motorcycle shops' },
];

/** Merchant addresses come from a fixed pool so a name always maps to one. */
const MERCHANT_POOL: `0x${string}`[] = [
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
];

export function addressForMerchant(name: string): `0x${string}` {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MERCHANT_POOL[h % MERCHANT_POOL.length];
}

const SEED: CatalogItem[] = [
  {
    sku: 'budget',
    label: 'Nimbus A1',
    blurb: '6.1" display · 64 GB · entry handset',
    cents: 14_900,
    merchant: 'Voltmart Electronics',
    merchantAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    mcc: '5732',
    mccLabel: 'consumer electronics',
    art: '📱',
  },
  {
    sku: 'commuter',
    label: 'Corso City 1 commuter bike',
    blurb: '7-speed · steel frame · rack and mudguards',
    cents: 29_900,
    merchant: 'Corso Cycles',
    merchantAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    mcc: '5940',
    mccLabel: 'bicycle shops',
    art: '🚲',
  },
  {
    sku: 'phone',
    label: 'Nimbus 9a',
    blurb: '6.3" display · 128 GB · dual SIM',
    cents: 49_900,
    merchant: 'Voltmart Electronics',
    merchantAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    mcc: '5732',
    mccLabel: 'consumer electronics',
    art: '📱',
  },
  {
    sku: 'bike',
    label: 'Corso Level 3 e-bike',
    blurb: '60 km range · 250 W hub motor · step-through',
    cents: 120_000,
    merchant: 'Corso Cycles',
    merchantAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    mcc: '5940',
    mccLabel: 'bicycle shops',
    art: '🚲',
  },
];

const STORE = fileURLToPath(new URL('../../data/catalog.json', import.meta.url));

/**
 * The catalog is mutable at runtime: the merchandiser agent adds items when a
 * shopper asks for something not stocked. Persisted so a restart does not lose
 * what was sourced mid-demo.
 */
class CatalogStore {
  private items = new Map<string, CatalogItem>();

  constructor() {
    for (const i of SEED) this.items.set(i.sku, i);
    try {
      const saved = JSON.parse(readFileSync(STORE, 'utf8')) as CatalogItem[];
      for (const i of saved) this.items.set(i.sku, i);
    } catch {
      // no store yet — seed only
    }
  }

  list(): CatalogItem[] {
    return [...this.items.values()];
  }

  find(sku: string): CatalogItem | undefined {
    return this.items.get(sku.toLowerCase());
  }

  add(item: CatalogItem): CatalogItem {
    this.items.set(item.sku, item);
    this.save();
    return item;
  }

  /** Drop everything the merchandiser added, keeping the seeded three. */
  resetToSeed(): void {
    this.items.clear();
    for (const i of SEED) this.items.set(i.sku, i);
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(STORE), { recursive: true });
      const sourced = this.list().filter((i) => i.sourcedAt);
      writeFileSync(STORE, JSON.stringify(sourced, null, 2));
    } catch {
      // a demo must not die because it could not write a cache file
    }
  }
}

export const catalog = new CatalogStore();

export const catalogList = (): CatalogItem[] => catalog.list();
export const findItem = (sku: string): CatalogItem | undefined => catalog.find(sku);

/** Distinct merchants, for the storefront's merchant-side view. */
export function merchants(): { name: string; address: `0x${string}` }[] {
  const seen = new Map<string, `0x${string}`>();
  for (const i of catalogList()) seen.set(i.merchant, i.merchantAddress);
  return [...seen].map(([name, address]) => ({ name, address }));
}

/** Kept for callers that still import the old shape. */
export const CATALOG = new Proxy(
  {},
  {
    get: (_t, k: string) => catalog.find(k),
    ownKeys: () => catalogList().map((i) => i.sku),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  },
) as Record<string, CatalogItem>;
