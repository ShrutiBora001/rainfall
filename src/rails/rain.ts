import crypto from 'node:crypto';
import {
  CardHandle,
  CardRails,
  CardSpec,
  Cents,
  CollateralState,
  AuthEvent,
  AuthRequest,
  AuthResult,
  RailsBalances,
  Decision,
  RailsError,
} from './types.js';

/**
 * Live Rain rails.
 *
 * Every route and field below was established by probing the sandbox directly
 * (docs.rain.xyz is access-code gated) and confirmed by creating real cards:
 *
 *   base      https://api-dev.raincards.xyz     (api.rain.xyz rejects this key)
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

/** Rain's published sandbox key for sealing the session secret. */
const SANDBOX_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCAP192809jZyaw62g/eTzJ3P9H
+RmT88sXUYjQ0K8Bx+rJ83f22+9isKx+lo5UuV8tvOlKwvdDS/pVbzpG7D7NO45c
0zkLOXwDHZkou8fuj8xhDO5Tq3GzcrabNLRLVz3dkx0znfzGOhnY4lkOMIdKxlQb
LuVM/dGDC9UpulF+UwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * The scoped-card endpoint requires a `sessionid`: a 32-char hex secret,
 * base64'd, then RSA-OAEP encrypted under Rain's public key and base64'd again.
 * The same secret decrypts the encryptedPan/encryptedCvc the card comes back
 * with — we don't need the PAN here, but keep the secret so a caller that does
 * can decrypt it.
 *
 * Note the padding hash is SHA-1, not SHA-256. SHA-256 fails.
 */
function newSession(pem = SANDBOX_PEM): { secretKey: string; sessionId: string } {
  const secretKey = crypto.randomUUID().replace(/-/g, '');
  const b64 = Buffer.from(secretKey, 'hex').toString('base64');
  const sealed = crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(b64, 'utf-8'),
  );
  return { secretKey, sessionId: sealed.toString('base64') };
}

export class RainRails implements CardRails {
  private readonly base: string;
  private handler?: (auth: AuthEvent) => Promise<Decision>;

  constructor(private readonly cfg: RainConfig) {
    this.base = (cfg.baseUrl ?? 'https://api-dev.raincards.xyz').replace(/\/$/, '');
  }

  private async req<T>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'api-key': this.cfg.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init.headers ?? {}),
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

  /**
   * Rain's scoped card — their agentic-commerce primitive, and the right tool
   * for this job. One call binds an amount, an expiry, and an MCC allowlist to
   * a single card, and Rain enforces all three at authorization rather than us
   * checking them after the fact.
   *
   * The plain /cards endpoint can only cap an amount, which is why this is a
   * different endpoint and not a parameter.
   */
  async issueScopedCard(spec: CardSpec): Promise<CardHandle> {
    const { sessionId, secretKey } = newSession();
    const r = await this.req<any>(
      `/v1/issuing/users/${this.cfg.userId}/cards/scoped`,
      {
        method: 'POST',
        body: {
          amountInUSDCents: spec.amountCents,
          allowedMccs: [spec.mcc],
          expiresAt: spec.expiresAt.toISOString(),
        },
        headers: { sessionid: sessionId },
      },
    );
    this.sessions.set(r.id, secretKey);
    return {
      cardId: r.id,
      last4: r.last4 ?? '????',
      status: normalize(r.status),
      limitCents: spec.amountCents,
    };
  }

  /** Session secret per card, for decrypting the PAN if a caller needs it. */
  private sessions = new Map<string, string>();

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

  // ---- authorizations, settlement, collateral ----
  //
  // These are Rain's sandbox simulation endpoints, documented at
  // rain-sandbox-trial.mintlify.site. They are how a card program is exercised
  // without a physical terminal, and they run the real authorization path:
  // limits, MCC rules, and the account's credit position all apply.

  /**
   * Fund the account's collateral contract. Observed on the sandbox: a 250000
   * deposit moved creditLimit from 1000000 to 1250000 — Rain enforces the
   * collateral/credit relationship itself.
   */
  async fundCollateral(contractId: string, cents: Cents): Promise<void> {
    await this.req('/v1/simulate/collateral/fund', {
      method: 'POST',
      body: { contractId, currency: 'rusd', amount: cents },
    });
  }

  /** A real authorization. Rain decides — including declining it. */
  async authorize(req: AuthRequest): Promise<AuthResult> {
    const r = await this.req<any>('/v1/simulate/transactions/authorize', {
      method: 'POST',
      body: {
        cardId: req.cardId,
        amount: req.amountCents,
        currency: 'USD',
        merchantName: req.merchant,
        merchantCategoryCode: req.mcc,
      },
    });
    return {
      transactionId: r.transactionId,
      status: r.status,
      declinedReason: r.declinedReason,
    };
  }

  /** `amount` is documented as optional; it is not. Always send it. */
  async settle(transactionId: string, cents: Cents): Promise<void> {
    await this.req(`/v1/simulate/transactions/${transactionId}/settle`, {
      method: 'POST',
      body: { amount: cents },
    });
  }

  async balances(): Promise<RailsBalances | null> {
    try {
      const r = await this.req<any>('/v1/issuing/balances');
      return {
        creditLimitCents: r.creditLimit ?? 0,
        pendingChargesCents: r.pendingCharges ?? 0,
        postedChargesCents: r.postedCharges ?? 0,
        spendingPowerCents: r.spendingPower ?? 0,
      };
    } catch {
      return null;
    }
  }

  // The collateral *read* and *claim* routes remain 403 for this key —
  // /v1/contracts/{id} and /v1/issuing/contracts both exist and both refuse
  // us. Funding works (above), reading the balance back does not, so the
  // authoritative ratio stays on Monad rather than being faked here.

  async getCollateral(_contractId: string): Promise<CollateralState> {
    throw new RailsError('Rain collateral read is 403 for this key', 403);
  }

  async setRequiredCollateral(_contractId: string, _ratioBps: number): Promise<void> {
    throw new RailsError('Rain collateral write is 403 for this key', 403);
  }

  async claimCollateral(_contractId: string, _amountCents: Cents): Promise<void> {
    throw new RailsError('Rain collateral claim is 403 for this key', 403);
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
