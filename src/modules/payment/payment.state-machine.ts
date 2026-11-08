import { ConflictError } from "../common/errors";
import { PaymentStatus, PayoutStatus } from "./payment.types";

export class PaymentStateMachine {
  // Allowed payment state transitions (includes mentor's gap-fixes)
  private static readonly VALID_PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
    CREATED: ["AUTH_PENDING", "RISK_REJECTED"],
    RISK_REJECTED: [], // Terminal
    AUTH_PENDING: ["AUTHORIZED", "DECLINED", "UNKNOWN"],
    DECLINED: [], // Terminal
    UNKNOWN: ["AUTHORIZED", "DECLINED"], // Resolved by recovery sweeper / reconciliation
    AUTHORIZED: ["CAPTURE_PENDING", "VOIDED"],
    CAPTURE_PENDING: ["CAPTURED", "AUTHORIZED"], // Gap-fix: allows retry on PSP decline/timeout
    CAPTURED: ["PARTIALLY_REFUNDED", "REFUNDED"],
    PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED"],
    REFUNDED: [], // Terminal
    VOIDED: [], // Terminal
  };

  private static readonly VALID_PAYOUT_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
    PENDING: ["PROCESSING"],
    PROCESSING: ["COMPLETED", "FAILED"],
    COMPLETED: [], // Terminal
    FAILED: [], // Terminal
  };

  public static isValidPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
    const allowed = this.VALID_PAYMENT_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  public static assertValidPaymentTransition(
    from: PaymentStatus,
    to: PaymentStatus,
    paymentId?: string
  ): void {
    if (!this.isValidPaymentTransition(from, to)) {
      const idPrefix = paymentId ? `for payment '${paymentId}' ` : "";
      throw new ConflictError(
        `Illegal payment state transition ${idPrefix}from '${from}' to '${to}'. Allowed: [${
          this.VALID_PAYMENT_TRANSITIONS[from]?.join(", ") || "None (Terminal)"
        }]`
      );
    }
  }

  public static isValidPayoutTransition(from: PayoutStatus, to: PayoutStatus): boolean {
    const allowed = this.VALID_PAYOUT_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  public static assertValidPayoutTransition(
    from: PayoutStatus,
    to: PayoutStatus,
    payoutId?: string
  ): void {
    if (!this.isValidPayoutTransition(from, to)) {
      const idPrefix = payoutId ? `for payout '${payoutId}' ` : "";
      throw new ConflictError(
        `Illegal payout state transition ${idPrefix}from '${from}' to '${to}'. Allowed: [${
          this.VALID_PAYOUT_TRANSITIONS[from]?.join(", ") || "None (Terminal)"
        }]`
      );
    }
  }
}
