import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../common/db";
import { AppError } from "../common/errors";
import { flatFeeBps, PLATFORM_FEE_BPS } from "../common/money";
import { LedgerService, proportionalFeeReversal } from "../ledger/ledger.service";
import type { Logger } from "../common/logger";
import type { CaptureDto, CreatePaymentDto, PaymentResponse, RefundDto, VoidDto } from "./payment.dto";
import {
  assertTransition,
  PaymentStatus,
} from "./payment-state";
import { PaymentRepository, type PaymentRow } from "./payment.repository";
import type { PspClient, PspOutcome } from "./psp/psp-client";

/**
 * PaymentService -- the orchestrator.
 *
 * THE CENTRAL RULE OF THIS FILE:
 *   a database transaction NEVER spans a provider call.
 *
 * The flow for authorize is deliberately split into three transactions:
 *
 *   TX1  create payment (CREATED) + claim intent            [commit]
 *   ---  call the provider (network, unbounded latency)     [no tx, no lock]
 *   TX2  record the outcome: status + event (+ ledger later) [commit]
 *
 * If we crash between TX1 and TX2 the payment sits in AUTH_PENDING and the
 * recovery sweeper resolves it with a status inquiry. That is the whole design:
 * the gap is a KNOWN state, not a lost charge.
 */
export class PaymentService {
  private readonly ledger: LedgerService;

  constructor(
    private readonly pool: Pool,
    private readonly psp: PspClient,
    private readonly logger: Logger,
    private readonly feeBps: bigint = PLATFORM_FEE_BPS,
  ) {
    this.ledger = new LedgerService(pool);
  }

  // -------------------------------------------------------------- authorize
  async createPayment(
    merchantId: string,
    dto: CreatePaymentDto,
    ctx: { correlationId?: string; idempotencyKey?: string } = {},
  ): Promise<PaymentResponse> {
    // ---------- TX1: persist the intent BEFORE talking to the provider ----------
    const created = await withTransaction(this.pool, async (client) => {
      const repo = new PaymentRepository(client);
      const payment = await repo.insert({
        merchantId,
        amount: dto.amount_minor,
        currency: dto.currency,
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.metadata !== undefined ? { metadata: dto.metadata } : {}),
      });

      // AUTH_PENDING is committed first, so a crash right now leaves a visible,
      // recoverable record instead of a charge with no trace.
      assertTransition(PaymentStatus.CREATED, PaymentStatus.AUTH_PENDING);
      const pending = await repo.updateStatus({
        paymentId: payment.id,
        expectedVersion: payment.version,
        status: PaymentStatus.AUTH_PENDING,
        set: { psp_reference: payment.psp_reference },
      });
      await repo.appendEvent({
        paymentId: payment.id,
        merchantId,
        eventType: "PAYMENT_CREATED",
        fromStatus: PaymentStatus.CREATED,
        toStatus: PaymentStatus.AUTH_PENDING,
        detail: { amount_minor: dto.amount_minor.toString(), currency: dto.currency },
        ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      });
      return pending ?? payment;
    });

    // ---------- provider call: NO transaction, NO row lock held ----------
    const outcome = await this.psp.authorize({
      ourReference: created.id,
      amount: BigInt(created.amount_minor),
      currency: created.currency,
      ...(dto.simulate ? { fault: dto.simulate } : {}),
    });

    // ---------- TX2: record what happened ----------
    return this.applyAuthorizeOutcome(created, outcome, ctx);
  }

  private async applyAuthorizeOutcome(
    payment: PaymentRow,
    outcome: PspOutcome<{ pspRef: string; status: string; declineCode?: string }>,
    ctx: { correlationId?: string },
  ): Promise<PaymentResponse> {
    return withTransaction(this.pool, async (client) => {
      const repo = new PaymentRepository(client);
      const locked = await repo.lockById(payment.id, payment.merchant_id);
      if (!locked) throw AppError.internal("payment disappeared during authorize");

      // Idempotent re-entry: if a callback already resolved this payment, do
      // NOT apply the synchronous outcome again. Whoever got there first wins,
      // and the state machine decides whether the second attempt is legal.
      if (locked.status !== PaymentStatus.AUTH_PENDING) {
        await repo.recordPspTransaction({
          paymentId: locked.id,
          operation: "AUTHORIZE",
          ourReference: locked.psp_reference,
          request: { amount_minor: locked.amount_minor, currency: locked.currency },
          outcome: outcome.kind === "SUCCESS" ? "SUCCESS" : outcome.kind === "DECLINED" ? "DECLINED" : outcome.kind,
          latencyMs: outcome.latencyMs,
        });
        return toPaymentResponse(locked);
      }

      let next: PaymentStatus;
      let detail: Record<string, unknown> = {};
      let pspRef: string | null = null;

      switch (outcome.kind) {
        case "SUCCESS":
          next = PaymentStatus.AUTHORIZED;
          pspRef = outcome.data.pspRef;
          detail = { psp_ref: outcome.data.pspRef, latency_ms: outcome.latencyMs };
          break;
        case "DECLINED":
          // A decline is a definitive answer from the provider.
          next = PaymentStatus.DECLINED;
          detail = { decline_code: outcome.code, message: outcome.message };
          break;
        case "TIMEOUT":
          // Silence is NOT a decline. We genuinely do not know.
          next = PaymentStatus.UNKNOWN;
          detail = { reason: "provider_timeout", latency_ms: outcome.latencyMs };
          break;
        case "ERROR":
          next = PaymentStatus.UNKNOWN;
          detail = { reason: "provider_error", message: outcome.message, status: outcome.status };
          break;
      }

      assertTransition(locked.status, next);

      const updated = await repo.updateStatus({
        paymentId: locked.id,
        expectedVersion: locked.version,
        status: next,
        set: {
          ...(pspRef ? { psp_ref: pspRef } : {}),
          ...(next === PaymentStatus.AUTHORIZED
            ? { authorized_amount: locked.amount_minor }
            : {}),
          ...(outcome.kind === "DECLINED" ? { decline_code: outcome.code } : {}),
        },
      });
      if (!updated) {
        // Version moved: another writer won. Return the fresh state; the caller
        // (or the client, with the same idempotency key) will see the truth.
        const current = await repo.findById(locked.id, locked.merchant_id);
        if (!current) throw AppError.internal("payment vanished after conflicting update");
        return toPaymentResponse(current);
      }

      await repo.appendEvent({
        paymentId: updated.id,
        merchantId: updated.merchant_id,
        eventType:
          next === PaymentStatus.AUTHORIZED
            ? "AUTHORIZED"
            : next === PaymentStatus.DECLINED
              ? "DECLINED"
              : "AUTHORIZE_OUTCOME_UNKNOWN",
        fromStatus: locked.status,
        toStatus: next,
        detail,
        ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      });

      await repo.recordPspTransaction({
        paymentId: updated.id,
        operation: "AUTHORIZE",
        ourReference: updated.psp_reference,
        pspRef,
        request: { amount_minor: updated.amount_minor, currency: updated.currency },
        response: outcome.kind === "SUCCESS" || outcome.kind === "DECLINED" ? outcome.raw : undefined,
        outcome: outcome.kind === "SUCCESS" ? "SUCCESS" : outcome.kind,
        latencyMs: outcome.latencyMs,
        errorMessage: outcome.kind === "ERROR" ? outcome.message : null,
      });

      if (next === PaymentStatus.UNKNOWN) {
        this.logger.warn(
          { payment_id: updated.id, reason: detail["reason"] },
          "payment_outcome_unknown_needs_recovery",
        );
      }
      return toPaymentResponse(updated);
    });
  }

  // ---------------------------------------------------------------- capture
  async capture(
    merchantId: string,
    paymentId: string,
    dto: CaptureDto,
    ctx: { correlationId?: string } = {},
  ): Promise<PaymentResponse> {
    // ---------- TX1: reserve the capture ----------
    const prepared = await withTransaction(this.pool, async (client) => {
      const repo = new PaymentRepository(client);
      const locked = await repo.lockById(paymentId, merchantId);
      if (!locked) throw AppError.notFound("Payment not found");

      // The state machine is the authority, not an if/else per caller.
      assertTransition(locked.status, PaymentStatus.CAPTURE_PENDING);

      const authorized = BigInt(locked.authorized_amount);
      const requested = dto.amount_minor ?? authorized;
      if (requested <= 0n) throw AppError.validation([{ field: "amount_minor", message: "must be positive" }]);
      if (requested > authorized) {
        throw AppError.unprocessable(
          `Capture amount ${requested} exceeds the authorised amount ${authorized}`,
        );
      }

      const updated = await repo.updateStatus({
        paymentId: locked.id,
        expectedVersion: locked.version,
        status: PaymentStatus.CAPTURE_PENDING,
      });
      if (!updated) throw AppError.conflict("Payment was modified concurrently, retry");

      await repo.appendEvent({
        paymentId: locked.id,
        merchantId,
        eventType: "CAPTURE_REQUESTED",
        fromStatus: locked.status,
        toStatus: PaymentStatus.CAPTURE_PENDING,
        detail: { amount_minor: requested.toString() },
        ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      });
      return { payment: updated, amount: requested };
    });

    // ---------- provider call, outside any transaction ----------
    const outcome = await this.psp.capture({
      ourReference: prepared.payment.psp_reference,
      pspRef: prepared.payment.psp_ref ?? prepared.payment.psp_reference,
      amount: prepared.amount,
    });

    // ---------- TX2: ledger + status + event, atomically ----------
    return withTransaction(this.pool, async (client) => {
      const repo = new PaymentRepository(client);
      const locked = await repo.lockById(paymentId, merchantId);
      if (!locked) throw AppError.internal("payment disappeared during capture");

      if (outcome.kind === "SUCCESS") {
        // Ledger + status + event share this transaction: either the money is
        // booked AND the payment is CAPTURED, or neither happened.
        // The posting is keyed by (payment, CAPTURE, 1), so a retry of this
        // exact step is a no-op instead of a second posting.
        const tx = await this.ledger.postCapture(client, {
          merchantId,
          paymentId: locked.id,
          currency: locked.currency,
          gross: prepared.amount,
          ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
        });

        // Supports partial capture: captured_amount is cumulative.
        const captured = BigInt(locked.captured_amount) + prepared.amount;
        const updated = await repo.updateStatus({
          paymentId: locked.id,
          expectedVersion: locked.version,
          status: PaymentStatus.CAPTURED,
          set: { captured_amount: captured.toString() },
        });
        if (!updated) throw AppError.conflict("Capture lost a concurrent race");

        await repo.appendEvent({
          paymentId: updated.id,
          merchantId,
          eventType: "CAPTURED",
          fromStatus: locked.status,
          toStatus: PaymentStatus.CAPTURED,
          detail: {
            amount_minor: prepared.amount.toString(),
            ledger_transaction_id: tx.transactionId,
            ledger_posted: tx.posted,
          },
          ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
        });
        await repo.recordPspTransaction({
          paymentId: updated.id,
          operation: "CAPTURE",
          ourReference: updated.psp_reference,
          pspRef: updated.psp_ref,
          request: { amount_minor: prepared.amount.toString() },
          response: outcome.raw,
          outcome: "SUCCESS",
          latencyMs: outcome.latencyMs,
        });
        return toPaymentResponse(updated);
      }

      // Decline / timeout / error: revert to AUTHORIZED (the gap-fix edge) so
      // the merchant can retry the capture. NO ledger entries were written.
      assertTransition(PaymentStatus.CAPTURE_PENDING, PaymentStatus.AUTHORIZED);
      const updated = await repo.updateStatus({
        paymentId: locked.id,
        expectedVersion: locked.version,
        status: PaymentStatus.AUTHORIZED,
      });
      if (!updated) throw AppError.conflict("Capture rollback lost a concurrent race");

      await repo.appendEvent({
        paymentId: updated.id,
        merchantId,
        eventType: outcome.kind === "DECLINED" ? "CAPTURE_DECLINED" : "CAPTURE_INCONCLUSIVE",
        fromStatus: PaymentStatus.CAPTURE_PENDING,
        toStatus: PaymentStatus.AUTHORIZED,
        detail: {
          outcome: outcome.kind,
          ...(outcome.kind === "DECLINED" ? { code: outcome.code } : {}),
          ...(outcome.kind === "ERROR" ? { message: outcome.message } : {}),
        },
        ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      });
      await repo.recordPspTransaction({
        paymentId: updated.id,
        operation: "CAPTURE",
        ourReference: updated.psp_reference,
        request: { amount_minor: prepared.amount.toString() },
        response: outcome.kind === "DECLINED" ? outcome.raw : undefined,
        outcome: outcome.kind === "DECLINED" ? "DECLINED" : outcome.kind,
        latencyMs: outcome.latencyMs,
      });

      if (outcome.kind === "DECLINED") {
        throw AppError.unprocessable(`Capture declined by provider: ${outcome.message}`, "PROVIDER_ERROR");
      }
      throw Object.assign(
        AppError.unprocessable("Provider did not confirm the capture, retry shortly", "PROVIDER_TIMEOUT"),
        { statusCode: 504 },
      );
    });
  }

  // ------------------------------------------------------------------- void
  async voidPayment(
    merchantId: string,
    paymentId: string,
    dto: VoidDto,
    ctx: { correlationId?: string } = {},
  ): Promise<PaymentResponse> {
    const prepared = await withTransaction(this.pool, async (client) => {
      const repo = new PaymentRepository(client);
      const locked = await repo.lockById(paymentId, merchantId);
      if (!locked) throw AppError.notFound("Payment not found");
      assertTransition(locked.status, PaymentStatus.VOIDED);
      if (locked.status !== PaymentStatus.AUTHORIZED) {
        throw AppError.conflict("Only an AUTHORIZED payment can be voided");
      }
      return locked;
    });

    const outcome = await this.psp.void({
      ourReference: prepared.psp_reference,
      pspRef: prepared.psp_ref ?? prepared.psp_reference,
    });

    return withTransaction(this.pool, async (client) => {
      const repo = new PaymentRepository(client);
      const locked = await repo.lockById(paymentId, merchantId);
      if (!locked) throw AppError.internal("payment disappeared during void");

      if (outcome.kind === "SUCCESS") {
        const updated = await repo.updateStatus({
          paymentId: locked.id,
          expectedVersion: locked.version,
          status: PaymentStatus.VOIDED,
        });
        if (!updated) throw AppError.conflict("Void lost a concurrent race");
        // A void writes NO ledger entries: the authorization never wrote any.
        await repo.appendEvent({
          paymentId: updated.id,
          merchantId,
          eventType: "VOIDED",
          fromStatus: locked.status,
          toStatus: PaymentStatus.VOIDED,
          detail: { reason: dto.reason ?? "merchant_request" },
          ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
        });
        return toPaymentResponse(updated);
      }

      // Void failed: the payment stays AUTHORIZED, nothing changed.
      await repo.appendEvent({
        paymentId: locked.id,
        merchantId,
        eventType: "VOID_FAILED",
        fromStatus: locked.status,
        toStatus: locked.status,
        detail: { outcome: outcome.kind },
        ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      });
      throw AppError.unprocessable(
        outcome.kind === "DECLINED" ? outcome.message : "Provider did not confirm the void",
        "PROVIDER_ERROR",
      );
    });
  }

  // ----------------------------------------------------------------- refund
  async refund(
    merchantId: string,
    paymentId: string,
    dto: RefundDto,
    ctx: { correlationId?: string } = {},
  ): Promise<PaymentResponse> {
    // TX1: RESERVE the refund locally. The row lock plus the reservation column
    // means two concurrent refunds cannot both pass the "refundable" test, even
    // though the provider call happens outside the transaction.
    const prepared = await withTransaction(this.pool, async (client) => {
      const repo = new PaymentRepository(client);
      const locked = await repo.lockById(paymentId, merchantId);
      if (!locked) throw AppError.notFound("Payment not found");

      if (locked.status !== PaymentStatus.CAPTURED && locked.status !== PaymentStatus.PARTIALLY_REFUNDED) {
        throw AppError.conflict(`Cannot refund a payment in status ${locked.status}`);
      }

      const captured = BigInt(locked.captured_amount);
      const refunded = BigInt(locked.refunded_amount);
      const reserved = BigInt(locked.refund_reserved_minor);
      const requested = dto.amount_minor;

      const refundable = captured - refunded - reserved;
      if (requested > refundable) {
        throw AppError.unprocessable(
          `Refund ${requested} exceeds the refundable amount ${refundable}` +
            (reserved > 0n ? ` (${reserved} is reserved by an in-flight refund)` : ""),
        );
      }

      // The reservation is what makes this safe: from now on this amount is
      // spoken for, even though the money has not moved yet.
      const reservedUpdate = await repo.reserveRefund(locked.id, locked.version, requested);
      if (!reservedUpdate) throw AppError.conflict("Another refund is in progress, retry");

      const sequence = (await repo.countRefunds(locked.id)) + 1;
      return { payment: locked, requested, sequence, captured, refunded };
    });

    const outcome = await this.psp.refund({
      ourReference: prepared.payment.psp_reference,
      pspRef: prepared.payment.psp_ref ?? prepared.payment.psp_reference,
      amount: prepared.requested,
    });

    return withTransaction(this.pool, async (client) => {
      const repo = new PaymentRepository(client);
      const locked = await repo.lockById(paymentId, merchantId);
      if (!locked) throw AppError.internal("payment disappeared during refund");

      if (outcome.kind !== "SUCCESS") {
        // Provider refused: release the reservation so the merchant can retry.
        // A TIMEOUT is different -- we do NOT know whether the provider
        // refunded, so releasing the reservation could allow a second refund.
        // The reservation is left in place and cleared by recovery after a
        // status inquiry (M7). Fail-safe beats fail-fast for money.
        if (outcome.kind !== "TIMEOUT") {
          await repo.releaseRefundReservation(locked.id, prepared.requested);
        }
        await repo.appendEvent({
          paymentId: locked.id,
          merchantId,
          eventType: "REFUND_FAILED",
          fromStatus: locked.status,
          toStatus: locked.status,
          detail: {
            outcome: outcome.kind,
            reservation_released: outcome.kind !== "TIMEOUT",
            amount_minor: prepared.requested.toString(),
          },
          ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
        });
        if (outcome.kind === "TIMEOUT") {
          throw AppError.providerTimeout("Provider did not answer the refund; it will be confirmed", {
            payment_id: locked.id,
            pending_minor: prepared.requested.toString(),
          });
        }
        throw AppError.providerError(
          outcome.kind === "DECLINED" ? outcome.message : "Provider rejected the refund",
        );
      }

      const captured = BigInt(locked.captured_amount);
      const refundedBefore = BigInt(locked.refunded_amount);
      const fee = flatFeeBps(captured, this.feeBps);
      const alreadyReversed = await this.sumFeeReversals(client, locked.id);
      const feeReversal = proportionalFeeReversal({
        fee,
        captured,
        refund: prepared.requested,
        alreadyRefunded: refundedBefore,
        alreadyReversed,
      });

      const tx = await this.ledger.postRefund(client, {
        merchantId,
        paymentId: locked.id,
        currency: locked.currency,
        refund: prepared.requested,
        feeReversal,
        sequence: prepared.sequence,
        ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      });

      const refundedTotal = refundedBefore + prepared.requested;
      const nextStatus =
        refundedTotal === captured ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
      assertTransition(locked.status, nextStatus);

      // Consume the reservation and record the refunded amount atomically.
      const updated = await repo.settleRefund(locked.id, locked.version, prepared.requested, refundedTotal, nextStatus);
      if (!updated) throw AppError.conflict("Refund lost a concurrent race");

      await repo.appendEvent({
        paymentId: updated.id,
        merchantId,
        eventType: "REFUNDED",
        fromStatus: locked.status,
        toStatus: nextStatus,
        detail: {
          amount_minor: prepared.requested.toString(),
          fee_reversal_minor: feeReversal.toString(),
          sequence: prepared.sequence,
          ledger_transaction_id: tx.transactionId,
        },
        ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      });
      await repo.recordPspTransaction({
        paymentId: updated.id,
        operation: "REFUND",
        ourReference: updated.psp_reference,
        pspRef: updated.psp_ref,
        request: { amount_minor: prepared.requested.toString() },
        response: outcome.raw,
        outcome: "SUCCESS",
        latencyMs: outcome.latencyMs,
      });

      return toPaymentResponse(updated);
    });
  }

  private async sumFeeReversals(client: PoolClient, paymentId: string): Promise<bigint> {
    const res = await client.query<{ total: string | null }>(
      `SELECT SUM(e.amount_minor)::text AS total
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
         JOIN accounts a ON a.id = e.account_id
        WHERE t.payment_id = $1
          AND t.kind = 'REFUND'
          AND a.code = 'FEE_REVENUE'
          AND e.direction = 'DEBIT'`,
      [paymentId],
    );
    return BigInt(res.rows[0]?.total ?? "0");
  }

  // ------------------------------------------------------------------ reads
  async getPayment(merchantId: string, paymentId: string): Promise<PaymentResponse> {
    const repo = new PaymentRepository(this.pool);
    const payment = await repo.findById(paymentId, merchantId);
    // Cross-tenant access is a 404 by design.
    if (!payment) throw AppError.notFound("Payment not found");
    return toPaymentResponse(payment);
  }

  async listPayments(merchantId: string, limit: number) {
    const repo = new PaymentRepository(this.pool);
    const rows = await repo.listForMerchant(merchantId, limit);
    return rows.map(toPaymentResponse);
  }

  async getEvents(merchantId: string, paymentId: string) {
    const repo = new PaymentRepository(this.pool);
    const payment = await repo.findById(paymentId, merchantId);
    if (!payment) throw AppError.notFound("Payment not found");
    const events = await repo.listEvents(paymentId, merchantId);
    return events.map((event) => ({
      id: String(event.id),
      event_type: event.event_type,
      from_status: event.from_status,
      to_status: event.to_status,
      detail: event.detail,
      created_at: event.created_at.toISOString(),
    }));
  }
}

export function toPaymentResponse(row: PaymentRow): PaymentResponse {
  return {
    id: row.id,
    status: row.status,
    amount_minor: String(row.amount_minor),
    authorized_amount_minor: String(row.authorized_amount),
    captured_amount_minor: String(row.captured_amount),
    refunded_amount_minor: String(row.refunded_amount),
    currency: row.currency,
    psp_reference: row.psp_reference,
    psp_ref: row.psp_ref,
    decline_code: row.decline_code,
    description: row.description,
    metadata: row.metadata,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
