import type { Cents } from '../rails/types.js';

/**
 * Merchants and products are deliberately fictional. A demo storefront wearing
 * a real retailer's name is impersonating that retailer, and these pages get
 * screenshotted and shared -- the MCCs are the real, load-bearing part.
 *
 * Merchant addresses are anvil's deterministic accounts 3 and 4.
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
}

export const CATALOG: Record<string, CatalogItem> = {
  phone: {
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
  bike: {
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
  headphones: {
    sku: 'headphones',
    label: 'Auric NC-7',
    blurb: 'Over-ear · active noise cancelling · 40 h battery',
    cents: 39_900,
    merchant: 'Voltmart Electronics',
    merchantAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    mcc: '5732',
    mccLabel: 'consumer electronics',
    art: '🎧',
  },
};

export const catalogList = (): CatalogItem[] => Object.values(CATALOG);

export function findItem(sku: string): CatalogItem | undefined {
  return CATALOG[sku.toLowerCase()];
}

/** Distinct merchants, for the storefront's merchant-side view. */
export function merchants(): { name: string; address: `0x${string}` }[] {
  const seen = new Map<string, `0x${string}`>();
  for (const i of catalogList()) seen.set(i.merchant, i.merchantAddress);
  return [...seen].map(([name, address]) => ({ name, address }));
}
