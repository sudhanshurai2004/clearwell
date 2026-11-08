import { AppError } from "../common/errors";

/**
 * PAYMENT STATE MACHINE
 *
 * This file is the single source of truth for legal status changes. Nothing in
 * the codebase sets payments.status directly; every change goes through
 * assertTransition(), which either returns or throws a 409.
 *
 *   CREATED ──► RISK_REJECTED
 *      └─────► AUTH_PENDING ──► AUTHORIZED ──► VOIDED
 *                   │               └──────► CAPTURE_PENDING ──► CAPTURED
 *                   ├──► DECLINED                     ▲                │
 *                   └──► UNKNOWN ──► AUTHORIZED ──────┘(retry)          ├──► PARTIALLY_REFUNDED
 *                            └─────► DECLINED                          └──► REFUNDED
 *                                                                          ▲
 *                                    PARTIALLY_REFUNDED ──────────────────┘
 *
 * Why is UNKNOWN a state and not an error?
 *   A provider timeout means WE DO NOT KNOW whether the charge happened. If we
 *   marked it DECLINED the merchant would retry and could charge the customer
 *   twice. UNKNOWN is the honest state: block, investigate (status inquiry),
 *   then resolve to AUTHORIZED or DECLINED.
 *
 * The gap-fixes approved in the design are the CAPTURE_PENDING -> AUTHORIZED
 * edge (a capture the provider refuses must not strand the payment) and the
 * UNKNOWN -> AUTHORIZED/DECLINED edges (resolution after inquiry).
 */
export const PaymentStatus = {
  CREATED: "CREATED",
  RISK_REJECTED: "RISK_REJECTED",
  AUTH_PENDING: "AUTH_PENDING",
  AUTHORIZED: "AUTHORIZED",
  DECLINED: "DECLINED",
  UNKNOWN: "UNKNOWN",
  VOIDED: "VOIDED",
  CAPTURE_PENDING: "CAPTURE_PENDING",
  CAPTURED: "CAPTURED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  REFUNDED: "REFUNDED",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  [PaymentStatus.CREATED]: [PaymentStatus.RISK_REJECTED, PaymentStatus.AUTH_PENDING],
  [PaymentStatus.AUTH_PENDING]: [
    PaymentStatus.AUTHORIZED,
    PaymentStatus.DECLINED,
    PaymentStatus.UNKNOWN,
  ],
  // UNKNOWN can also be resolved by reconciliation, hence both targets.
  [PaymentStatus.UNKNOWN]: [PaymentStatus.AUTHORIZED, PaymentStatus.DECLINED],
  [PaymentStatus.AUTHORIZED]: [PaymentStatus.VOIDED, PaymentStatus.CAPTURE_PENDING],
  [PaymentStatus.CAPTURE_PENDING]: [PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED],
  [PaymentStatus.CAPTURED]: [PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED],
  [PaymentStatus.PARTIALLY_REFUNDED]: [PaymentStatus.REFUNDED],
  [PaymentStatus.REFUNDED]: [],
  [PaymentStatus.VOIDED]: [],
  [PaymentStatus.DECLINED]: [],
  [PaymentStatus.RISK_REJECTED]: [],
};

/** States where the payment is settled for good -- nothing may change it. */
export const TERMINAL_STATES: readonly PaymentStatus[] = [
  PaymentStatus.REFUNDED,
  PaymentStatus.VOIDED,
  PaymentStatus.DECLINED,
  PaymentStatus.RISK_REJECTED,
];

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: PaymentStatus): readonly PaymentStatus[] {
  return TRANSITIONS[from];
}

/**
 * Throws 409 CONFLICT for an illegal transition. 409 (not 400) because the
 * request was well-formed -- it just does not fit the current state, which is
 * exactly what "conflict" means.
 */
export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw AppError.conflict(
      `Illegal payment transition ${from} -> ${to}. Allowed from ${from}: ${
        TRANSITIONS[from].length > 0 ? TRANSITIONS[from].join(", ") : "none (terminal state)"
      }`,
    );
  }
}

/**
 * Payout lifecycle (separate machine, agreed in the design as a gap-fix):
 *   PENDING -> PROCESSING -> COMPLETED | FAILED
 */
export const PayoutStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = {
  [PayoutStatus.PENDING]: [PayoutStatus.PROCESSING],
  [PayoutStatus.PROCESSING]: [PayoutStatus.COMPLETED, PayoutStatus.FAILED],
  [PayoutStatus.COMPLETED]: [],
  [PayoutStatus.FAILED]: [],
};

export function canTransitionPayout(from: PayoutStatus, to: PayoutStatus): boolean {
  return PAYOUT_TRANSITIONS[from].includes(to);
}

export function assertPayoutTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransitionPayout(from, to)) {
    throw AppError.conflict(`Illegal payout transition ${from} -> ${to}`);
  }
}
