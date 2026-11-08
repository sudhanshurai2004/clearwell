import crypto from "node:crypto";

/**
 * In-memory state of the SIMULATED payment provider.
 *
 * This process is deliberately dumb: it behaves like a real provider as seen
 * from outside (opaque ids, idempotency by reference, asynchronous callbacks)
 * and is NOT part of the business logic. It holds its own state so it can be
 * restarted, reset, and used to inject faults. No real money, no card data.
 *
 * Idempotency model (same as Stripe/PayPal):
 *   every mutating call carries `our_reference`. If we already saw that
 *   reference for the same operation, we return the ORIGINAL result instead of
 *   doing the work twice. That is what makes "retry after timeout" safe.
 */
export type PspPaymentStatus =
  | "AUTHORIZED"
  | "DECLINED"
  | "VOIDED"
  | "CAPTURED"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED";

export type PspPayment = {
  id: string;
  ourReference: string;
  amount: bigint;
  currency: string;
  status: PspPaymentStatus;
  capturedAmount: bigint;
  refundedAmount: bigint;
  declineCode?: string;
  idempotency: Map<string, PspOperationResult>;
  createdAt: Date;
};

export type PspOperationResult = {
  status: number;
  body: Record<string, unknown>;
};

export type FaultMode = "approve" | "decline" | "timeout" | "latency" | "error";

export class PspStore {
  private readonly payments = new Map<string, PspPayment>();
  private readonly byReference = new Map<string, PspPayment>();
  private readonly callbacks: { url: string; payload: Record<string, unknown> }[] = [];

  /** Reset between tests; also exposed as POST /psp/_reset. */
  reset(): void {
    this.payments.clear();
    this.byReference.clear();
    this.callbacks.length = 0;
  }

  createPayment(input: {
    ourReference: string;
    amount: bigint;
    currency: string;
    fault?: FaultMode;
  }): PspPayment {
    const payment: PspPayment = {
      id: `psp_${crypto.randomBytes(10).toString("hex")}`,
      ourReference: input.ourReference,
      amount: input.amount,
      currency: input.currency,
      status: input.fault === "decline" ? "DECLINED" : "AUTHORIZED",
      capturedAmount: 0n,
      refundedAmount: 0n,
      ...(input.fault === "decline" ? { declineCode: "card_declined" } : {}),
      idempotency: new Map(),
      createdAt: new Date(),
    };
    this.payments.set(payment.id, payment);
    this.byReference.set(input.ourReference, payment);
    return payment;
  }

  findById(id: string): PspPayment | undefined {
    return this.payments.get(id);
  }

  findByReference(reference: string): PspPayment | undefined {
    return this.byReference.get(reference);
  }

  all(): PspPayment[] {
    return [...this.payments.values()];
  }

  recordCallback(url: string, payload: Record<string, unknown>): void {
    this.callbacks.push({ url, payload });
  }

  pendingCallbacks(): { url: string; payload: Record<string, unknown> }[] {
    return [...this.callbacks];
  }

  clearCallbacks(): void {
    this.callbacks.length = 0;
  }
}
