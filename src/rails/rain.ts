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
 * Every route and field below was established by probing the sandbox directly
 * (docs.rain.xyz is access-code gated) and confirmed by creating real cards:
 *
 *   base      https://api-dev.rain.xyz     (api.rain.xyz rejects this key)
 *   auth      header `api-key`             (not Authorization: Bearer)
 *   create    POST /v1/issuing/users/{userId}/cards
 *             body {type:"virtual", limit:{amount:<cents>, frequency:<enum>}}
 *             NOTE: POST /v1/issuing/cards is 404 -- creation is nested
 *             under the user, which is also where liability sits.
 *   list/get  GET  /v1/issuing/cards        GET /v1/issuing/cards/{id}
 *   mutate    PATCH /v1/issuing/cards/{id}  {status} and/or {limit}
 *
 * Enums are camelCase and narrow:
 *   frequency  "perAuthorization" | "allTime"
 *   status     "active" | "locked" | "canceled"
 *
 * The PATCH response echoes the *pre-update* body; re-read with GET to observe
 * the change. That cost an hour -- do not trust the PATCH echo.
 */
export interface RainConfig {
  apiKey: string;
  baseUrl?: string;
  userId: string;
  collateralContractId: string;
}

type RainStatus = 'active' | 'locked' | 'canceled';

export class RainRails implements CardRails {
  private readonly base: string;
  private handler?: (auth: AuthEvent) => Promise<Decision>;

  constructor(private readonly cfg: RainConfig) {
    this.base = (cfg.baseUrl ?? 'https://api-dev.rain.xyz').replace(/\/$/, '');
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
      throw new RailsError(
        `Rain ${init.method ?? 'GET'} ${path} -> ${res.status}`,
        res.status,
        parsed ?? text,
      );
    }
    return parsed as T;
  }

  async issueScopedCard(spec: CardSpec): Promise<CardHandle> {
    const r = await this.req<any>(`/v1/issuing/users/${this.cfg.userId}/cards`, {
      method: 'POST',
      body: {
        type: 'virtual',
        // One authorization, one amount. Rain's own control surface doing
        // exactly what the scoped-card design asks of it.
        limit: { amount: spec.amountCents, frequency: 'perAuthorization' },
      },
    });
    return { cardId: r.id, last4: r.last4 ?? '????', status: normalize(r.status) };
  }

  async freezeCard(cardId: string): Promise<void> {
    await this.patch(cardId, { status: 'locked' });
  }

  async revokeCard(cardId: string): Promise<void> {
    await this.patch(cardId, { status: 'canceled' });
  }

  /**
   * Move a card's spend ceiling. This is the ladder's real teeth on the Rain
   * side: as the agent's standing rises on Monad, the amount its card may
   * authorize rises with it, on Rain's infrastructure, observable via GET.
   */
  async setSpendLimit(cardId: string, cents: Cents): Promise<void> {
    await this.patch(cardId, { limit: { amount: cents, frequency: 'allTime' } });
  }

  private async patch(cardId: string, body: Record<string, unknown>): Promise<void> {
    await this.req(`/v1/issuing/cards/${cardId}`, { method: 'PATCH', body });
  }

  async getCard(cardId: string): Promise<CardHandle | null> {
    try {
      const r = await this.req<any>(`/v1/issuing/cards/${cardId}`);
      return {
        cardId: r.id,
        last4: r.last4 ?? '????',
        status: normalize(r.status),
        limitCents: r.limit?.amount ?? null,
      };
    } catch (e) {
      if (e instanceof RailsError && e.status === 404) return null;
      throw e;
    }
  }

  async listCards(): Promise<CardHandle[]> {
    const r = await this.req<any[]>('/v1/issuing/cards');
    return r.map((c) => ({
      cardId: c.id,
      last4: c.last4 ?? '????',
      status: normalize(c.status),
      limitCents: c.limit?.amount ?? null,
    }));
  }

  /** Rain delivers authorizations by webhook; the caller forwards them here. */
  onAuthorization(cb: (auth: AuthEvent) => Promise<Decision>): void {
    this.handler = cb;
  }

  async handleWebhook(auth: AuthEvent): Promise<Decision> {
    if (!this.handler) throw new RailsError('no authorization handler bound');
    return this.handler(auth);
  }

  // ---- collateral ----
  //
  // /v1/contracts/{id} and /v1/issuing/contracts both return 403 for this key:
  // the routes exist, we are not scoped to them. Rather than fake a number,
  // these throw and the caller mirrors the ratio on Monad instead. The card
  // spend limit above is the part of the ladder that genuinely executes here.

  async getCollateral(_contractId: string): Promise<CollateralState> {
    throw new RailsError('Rain collateral routes are 403 for this key', 403);
  }

  async setRequiredCollateral(_contractId: string, _ratioBps: number): Promise<void> {
    throw new RailsError('Rain collateral routes are 403 for this key', 403);
  }

  async claimCollateral(_contractId: string, _amountCents: Cents): Promise<void> {
    throw new RailsError('Rain collateral routes are 403 for this key', 403);
  }
}

function normalize(s: string | undefined): CardHandle['status'] {
  if (s === 'locked') return 'frozen';
  if (s === 'canceled') return 'revoked';
  return 'active';
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
