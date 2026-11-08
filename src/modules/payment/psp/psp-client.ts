/**
 * PROVIDER ADAPTER INTERFACE
 *
 * Everything in the payment module talks to this interface, never to fetch/HTTP
 * directly. That is what lets us swap the simulator for Stripe or PayPal later
 * without touching business logic, and lets tests inject a hostile fake:
 *
 *   interface PspClient  ──► HttpPspClient  (talks to our simulator)
 *                        └─► StripePspClient (future)
 *
 * The return type is a closed union on purpose: callers MUST handle TIMEOUT
 * explicitly. If the method just threw a generic error, the "never mark a
 * timeout as declined" rule would depend on remembering to catch it correctly
 * at every call site. Here the compiler enforces it.
 */
export type PspOutcome<T> =
  | { kind: "SUCCESS"; data: T; raw: unknown; latencyMs: number }
  | { kind: "DECLINED"; code: string; message: string; raw: unknown; latencyMs: number }
  | { kind: "TIMEOUT"; latencyMs: number }
  | { kind: "ERROR"; message: string; status?: number; raw?: unknown; latencyMs: number };

export type PspAuthorizeRequest = {
  /** OUR payment id: the provider's idempotency reference for this intent. */
  ourReference: string;
  amount: bigint;
  currency: string;
  /** Simulator-only fault hint; real adapters ignore it. */
  fault?: "approve" | "decline" | "timeout" | "latency";
};

export type PspAuthorizeResult = {
  pspRef: string;
  status: "AUTHORIZED" | "DECLINED";
  declineCode?: string;
};

export type PspCaptureRequest = {
  ourReference: string;
  pspRef: string;
  amount: bigint;
};

export type PspCaptureResult = {
  pspRef: string;
  capturedAmount: bigint;
  status: "CAPTURED";
};

export type PspVoidRequest = { ourReference: string; pspRef: string };
export type PspVoidResult = { status: "VOIDED" };

export type PspRefundRequest = { ourReference: string; pspRef: string; amount: bigint };
export type PspRefundResult = { refundedAmount: bigint; status: "REFUNDED" | "PARTIALLY_REFUNDED" };

/** What the provider says actually happened -- the recovery sweeper's oracle. */
export type PspInquiryResult = {
  pspRef: string;
  status: "AUTHORIZED" | "DECLINED" | "VOIDED" | "CAPTURED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "UNKNOWN";
  capturedAmount: bigint;
  refundedAmount: bigint;
  declineCode?: string;
};

export interface PspClient {
  authorize(request: PspAuthorizeRequest): Promise<PspOutcome<PspAuthorizeResult>>;
  capture(request: PspCaptureRequest): Promise<PspOutcome<PspCaptureResult>>;
  void(request: PspVoidRequest): Promise<PspOutcome<PspVoidResult>>;
  refund(request: PspRefundRequest): Promise<PspOutcome<PspRefundResult>>;
  /** Status inquiry by OUR reference (we may never have received a pspRef). */
  inquire(ourReference: string): Promise<PspOutcome<PspInquiryResult>>;
}
