/**
 * Card rails: the payment network that actually moves money.
 *
 * Rainfall's credit logic lives on Monad. This layer only issues, scopes, and
 * kills cards, and reports/adjusts the collateral backing them. Nothing about
 * installments, scoring, or underwriting belongs here.
 */

/** Money is always integer cents. Never floats, never bigint dollars. */
export type Cents = number;

export interface CardSpec {
  /** Merchant the card is locked to. Single-merchant by design. */
  merchant: string;
  /** Visa MCC, e.g. 5732 consumer electronics, 5940 bicycle shops. */
  mcc: string;
  /** Exact authorization ceiling. Single-amount by design. */
  amountCents: Cents;
  /** Short expiry — minutes, not months. Scope is the whole point. */
  expiresAt: Date;
  /** Agent this card is issued to; ties the card back to AgentRegistry. */
  agentId: string;
}

export interface CardHandle {
  cardId: string;
  last4: string;
  status: CardStatus;
}

export type CardStatus = 'active' | 'frozen' | 'revoked';

export interface AuthEvent {
  cardId: string;
  merchant: string;
  mcc: string;
  amountCents: Cents;
  /** Rain's authorization id, echoed back when we approve or decline. */
  authId: string;
}

export interface Decision {
  approve: boolean;
  /** Surfaced in logs and the dashboard when declined. */
  reason?: string;
}

export interface CollateralState {
  lockedCents: Cents;
  availableCents: Cents;
}

export interface CardRails {
  issueScopedCard(spec: CardSpec): Promise<CardHandle>;
  freezeCard(cardId: string): Promise<void>;
  revokeCard(cardId: string): Promise<void>;
  getCard(cardId: string): Promise<CardHandle | null>;

  /**
   * Called on every authorization. The callback runs the Monad underwriting
   * read, so it must return inside the network's auth window.
   */
  onAuthorization(cb: (auth: AuthEvent) => Promise<Decision>): void;

  /**
   * Collateral contract — the seam where the underwriting ladder stops being
   * a number on a dashboard and becomes the principal's capital moving.
   */
  getCollateral(contractId: string): Promise<CollateralState>;
  setRequiredCollateral(contractId: string, ratioBps: number): Promise<void>;
  claimCollateral(contractId: string, amountCents: Cents): Promise<void>;
}

/** Thrown when rails reject an operation; carries the upstream status. */
export class RailsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RailsError';
  }
}
