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
  /** Current spend ceiling, when the rails report one. */
  limitCents?: Cents | null;
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

export interface AuthRequest {
  cardId: string;
  amountCents: Cents;
  merchant: string;
  mcc: string;
}

export interface AuthResult {
  transactionId: string;
  /** "authorized" or "declined" — the rails' own decision, not ours. */
  status: string;
  declinedReason?: string;
}

export interface RailsBalances {
  creditLimitCents: Cents;
  pendingChargesCents: Cents;
  postedChargesCents: Cents;
  spendingPowerCents: Cents;
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
  /**
   * Move a card's spend ceiling. On live Rain this is where the underwriting
   * ladder actually executes — the collateral routes are 403 for our key, but
   * the spend limit is ours to move.
   */
  setSpendLimit(cardId: string, cents: Cents): Promise<void>;

  /**
   * Put collateral behind the account. On live Rain this raises the account's
   * credit limit by the deposited amount — the collateral/credit relationship
   * this whole project models, enforced by the card network rather than by us.
   */
  fundCollateral(contractId: string, cents: Cents): Promise<void>;

  /** Run a real card authorization through the rails. */
  authorize(req: AuthRequest): Promise<AuthResult>;

  /** Turn an authorization hold into a posted charge. */
  settle(transactionId: string, cents: Cents): Promise<void>;

  /** Account-level credit position as the rails see it. */
  balances(): Promise<RailsBalances | null>;

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
