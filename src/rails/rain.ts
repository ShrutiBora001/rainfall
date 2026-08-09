import {
  CardHandle,
  CardRails,
  CardSpec,
  Cents,
  CollateralState,
  AuthEvent,
  Decision,
  RailsError,
} from './types.js';

/**
 * Live Rain rails.
 *
 * Confirmed by probing the API directly (docs.rain.xyz is access-code gated):
 *   - base https://api.rain.xyz, Fastify, /v1/*, 1000 req rate limit
 *   - auth header is `api-key`, NOT `Authorization: Bearer`
 *   - real routes: /v1/cards, /v1/issuing/cards, /v1/transactions
 *   - /v1/collateral-contracts is NOT a route; the collateral path is unknown
 *
 * Anything below marked UNVERIFIED is a guess at the shape and must be checked
 * against the sandbox before the demo. Guesses are isolated in one place on
 * purpose — correcting them should be a single-file change.
 */
export interface RainConfig {
  apiKey: string;
  baseUrl?: string;
  collateralContractId: string;
  /** Override once the real collateral route is known. */
  collateralPath?: string;
}

export class RainRails implements CardRails {
  private readonly base: string;
  private readonly collateralPath: string;
  private handler?: (auth: AuthEvent) => Promise<Decision>;

  constructor(private readonly cfg: RainConfig) {
    this.base = (cfg.baseUrl ?? 'https://api.rain.xyz').replace(/\/$/, '');
    this.collateralPath = cfg.collateralPath ?? '/v1/collateral-contracts';
  }

  private async req<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'api-key': this.cfg.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    const text = await res.text();
    const parsed = text ? safeJson(text) : null;

    if (!res.ok) {
      // 401 "Invalid api key" means the key is inactive, not that the call is
      // malformed — routing and header parsing already succeeded by then.
      throw new RailsError(
        `Rain ${init.method ?? 'GET'} ${path} -> ${res.status}`,
        res.status,
        parsed ?? text,
      );
    }
    return parsed as T;
  }

  async issueScopedCard(spec: CardSpec): Promise<CardHandle> {
    // UNVERIFIED body shape.
    const r = await this.req<any>('/v1/issuing/cards', {
      method: 'POST',
      body: {
        type: 'virtual',
        spendLimit: spec.amountCents,
        spendLimitInterval: 'per_authorization',
        merchantAllowlist: [spec.merchant],
        mccAllowlist: [spec.mcc],
        expiresAt: spec.expiresAt.toISOString(),
        metadata: { agentId: spec.agentId, issuer: 'rainfall' },
      },
    });
    return { cardId: r.id ?? r.cardId, last4: r.last4 ?? '????', status: 'active' };
  }

  async freezeCard(cardId: string): Promise<void> {
    await this.req(`/v1/issuing/cards/${cardId}`, {
      method: 'PATCH',
      body: { status: 'frozen' },
    });
  }

  async revokeCard(cardId: string): Promise<void> {
    await this.req(`/v1/issuing/cards/${cardId}`, {
      method: 'PATCH',
      body: { status: 'canceled' },
    });
  }

  async getCard(cardId: string): Promise<CardHandle | null> {
    try {
      const r = await this.req<any>(`/v1/issuing/cards/${cardId}`);
      return {
        cardId: r.id ?? cardId,
        last4: r.last4 ?? '????',
        status: normalizeStatus(r.status),
      };
    } catch (e) {
      if (e instanceof RailsError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Rain delivers authorizations by webhook, so the caller must also run the
   * webhook server and forward events here. Registering the handler alone does
   * not subscribe to anything.
   */
  onAuthorization(cb: (auth: AuthEvent) => Promise<Decision>): void {
    this.handler = cb;
  }

  /** Entry point for the webhook route to call. */
  async handleWebhook(auth: AuthEvent): Promise<Decision> {
    if (!this.handler) throw new RailsError('no authorization handler bound');
    return this.handler(auth);
  }

  async getCollateral(contractId: string): Promise<CollateralState> {
    const r = await this.req<any>(`${this.collateralPath}/${contractId}`);
    return {
      lockedCents: r.lockedAmount ?? r.locked ?? 0,
      availableCents: r.availableAmount ?? r.available ?? 0,
    };
  }

  async setRequiredCollateral(contractId: string, ratioBps: number): Promise<void> {
    await this.req(`${this.collateralPath}/${contractId}`, {
      method: 'PATCH',
      body: { requiredCollateralBps: ratioBps },
    });
  }

  async claimCollateral(contractId: string, amountCents: Cents): Promise<void> {
    await this.req(`${this.collateralPath}/${contractId}/claim`, {
      method: 'POST',
      body: { amount: amountCents },
    });
  }
}

function normalizeStatus(s: string | undefined): CardHandle['status'] {
  if (s === 'frozen' || s === 'paused' || s === 'suspended') return 'frozen';
  if (s === 'canceled' || s === 'cancelled' || s === 'revoked') return 'revoked';
  return 'active';
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
