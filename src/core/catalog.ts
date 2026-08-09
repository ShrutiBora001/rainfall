import type { Cents } from '../rails/types.js';

/** Merchant addresses are anvil's deterministic accounts 3 and 4. */
export interface CatalogItem {
  sku: string;
  label: string;
  cents: Cents;
  merchant: string;
  merchantAddress: `0x${string}`;
  mcc: string;
}

export const CATALOG: Record<string, CatalogItem> = {
  phone: {
    sku: 'phone',
    label: 'Pixel 9a',
    cents: 49_900,
    merchant: 'BestBuy',
    merchantAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    mcc: '5732', // consumer electronics
  },
  bike: {
    sku: 'bike',
    label: 'Aventon Level.3 e-bike',
    cents: 120_000,
    merchant: 'CycleWorks',
    merchantAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    mcc: '5940', // bicycle shops
  },
  headphones: {
    sku: 'headphones',
    label: 'Sony WH-1000XM6',
    cents: 39_900,
    merchant: 'BestBuy',
    merchantAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    mcc: '5732',
  },
};

export const catalogList = (): CatalogItem[] => Object.values(CATALOG);

export function findItem(sku: string): CatalogItem | undefined {
  return CATALOG[sku.toLowerCase()];
}
