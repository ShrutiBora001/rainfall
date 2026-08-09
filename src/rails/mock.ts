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
 * In-memory rails. Two jobs:
 *   1. Unblock the build while the Rain sandbox key is inactive.
 *   2. Let the demo trigger an authorization — and a missed payment — on cue.
 *
 * The second matters more. The delinquency path is the centerpiece of the
 * pitch and it cannot be driven reliably against a live sandbox on stage.
 */
export class MockRails implements CardRails {
  private cards = new Map<string, CardHandle & { spec: CardSpec; limitCents: Cents }>();
  private collateral = new Map<string, CollateralState>();
  private requiredBps = new Map<string, number>();
  private handler?: (auth: AuthEvent) => Promise<Decision>;
  private seq = 0;

  constructor(opts: { contractId: string; startingCollateralCents: Cents }) {
    this.collateral.set(opts.contractId, {
      lockedCents: 0,
      availableCents: opts.startingCollateralCents,
    });
    this.requiredBps.set(opts.contractId, 10_000);
  }

  async issueScopedCard(spec: CardSpec): Promise<CardHandle> {
    const cardId = `card_mock_${++this.seq}`;
    const handle: CardHandle = {
      cardId,
      last4: String(4000 + this.seq).slice(-4),
      status: 'active',
    };
    this.cards.set(cardId, { ...handle, spec, limitCents: spec.amountCents });
    return handle;
  }

  async freezeCard(cardId: string): Promise<void> {
    this.mutate(cardId, 'frozen');
  }

  async revokeCard(cardId: string): Promise<void> {
    this.mutate(cardId, 'revoked');
  }

  async getCard(cardId: string): Promise<CardHandle | null> {
    const c = this.cards.get(cardId);
    return c
      ? { cardId: c.cardId, last4: c.last4, status: c.status, limitCents: c.limitCents }
      : null;
  }

  async setSpendLimit(cardId: string, cents: Cents): Promise<void> {
    const c = this.cards.get(cardId);
    if (!c) throw new RailsError(`unknown card ${cardId}`);
    c.limitCents = cents;
  }

  onAuthorization(cb: (auth: AuthEvent) => Promise<Decision>): void {
    this.handler = cb;
  }

  async getCollateral(contractId: string): Promise<CollateralState> {
    const c = this.collateral.get(contractId);
    if (!c) throw new RailsError(`unknown collateral contract ${contractId}`);
    return { ...c };
  }

  async setRequiredCollateral(contractId: string, ratioBps: number): Promise<void> {
    if (ratioBps < 0 || ratioBps > 10_000) {
      throw new RailsError(`ratioBps out of range: ${ratioBps}`);
    }
    const c = await this.getCollateral(contractId);
    this.requiredBps.set(contractId, ratioBps);

    // Releasing collateral is the visible half of the underwriting ladder:
    // as the ratio drops, locked capital returns to the principal.
    const total = c.lockedCents + c.availableCents;
    const shouldLock = Math.floor((total * ratioBps) / 10_000);
    const bounded = Math.min(shouldLock, total);
    this.collateral.set(contractId, {
      lockedCents: bounded,
      availableCents: total - bounded,
    });
  }

  async claimCollateral(contractId: string, amountCents: Cents): Promise<void> {
    const c = await this.getCollateral(contractId);
    if (amountCents > c.lockedCents) {
      throw new RailsError(
        `claim ${amountCents} exceeds locked ${c.lockedCents}`,
      );
    }
    this.collateral.set(contractId, {
      lockedCents: c.lockedCents - amountCents,
      availableCents: c.availableCents,
    });
  }

  async fundCollateral(contractId: string, cents: Cents): Promise<void> {
    const c = await this.getCollateral(contractId);
    this.collateral.set(contractId, {
      lockedCents: c.lockedCents,
      availableCents: c.availableCents + cents,
    });
  }

  async authorize(req: AuthRequest): Promise<AuthResult> {
    const d = await this.simulateAuthorization(req.cardId, req.amountCents);
    return {
      transactionId: `tx_mock_${++this.seq}`,
      status: d.approve ? 'authorized' : 'declined',
      declinedReason: d.reason,
    };
  }

  async settle(_transactionId: string, _cents: Cents): Promise<void> {}

  async balances(): Promise<RailsBalances | null> {
    return null;
  }

  // ---- demo controls, not part of CardRails ----

  /** Drive an authorization by hand. This is how the demo buys a phone. */
  async simulateAuthorization(
    cardId: string,
    amountCents: Cents,
  ): Promise<Decision> {
    const card = this.cards.get(cardId);
    if (!card) throw new RailsError(`unknown card ${cardId}`);
    if (card.status !== 'active') {
      return { approve: false, reason: `card is ${card.status}` };
    }
    if (amountCents > card.spec.amountCents) {
      return { approve: false, reason: 'exceeds card ceiling' };
    }
    if (new Date() > card.spec.expiresAt) {
      return { approve: false, reason: 'card expired' };
    }
    if (!this.handler) throw new RailsError('no authorization handler bound');

    return this.handler({
      cardId,
      merchant: card.spec.merchant,
      mcc: card.spec.mcc,
      amountCents,
      authId: `auth_mock_${++this.seq}`,
    });
  }

  requiredCollateralBps(contractId: string): number {
    return this.requiredBps.get(contractId) ?? 10_000;
  }

  private mutate(cardId: string, status: CardHandle['status']): void {
    const c = this.cards.get(cardId);
    if (!c) throw new RailsError(`unknown card ${cardId}`);
    // Revocation is terminal; a frozen card can still be revoked.
    if (c.status === 'revoked') return;
    c.status = status;
  }
}
