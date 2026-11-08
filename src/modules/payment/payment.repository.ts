import type { Pool, PoolClient } from "pg";
import { newId } from "../common/ids";
import type { PaymentStatus } from "./payment-state";

export type PaymentRow = {
  id: string;
  merchant_id: string;
  amount_minor: string;
  currency: string;
  authorized_amount: string;
  captured_amount: string;
  refunded_amount: string;
  status: PaymentStatus;
  refund_reserved_minor: string;
  refund_reserved_at: Date | null;
  psp_reference: string;
  psp_ref: string | null;
  decline_code: string | null;
  description: string | null;
  metadata: Record<string, string>;
  version: number;
  created_at: Date;
  updated_at: Date;
};

export type PaymentEventRow = {
  id: string;
  payment_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
};

export class PaymentRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  async insert(input: {
    merchantId: string;
    amount: bigint;
    currency: string;
    description?: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentRow> {
    const id = newId();
    const res = await this.db.query<PaymentRow>(
      `INSERT INTO payments
         (id, merchant_id, amount_minor, currency, status, psp_reference, description, metadata)
       VALUES ($1, $2, $3, $4, 'CREATED', $1, $5, $6)
       RETURNING *`,
      [id, input.merchantId, input.amount.toString(), input.currency, input.description ?? null, input.metadata ?? {}],
    );
    return res.rows[0] as PaymentRow;
  }

  /**
   * Row lock for every state transition.
   *
   * SELECT ... FOR UPDATE serialises concurrent requests on the same payment:
   * two simultaneous captures queue up, the second one re-reads the status
   * AFTER the first committed, and is rejected by the state machine instead of
   * capturing twice. The lock is held for microseconds because no network call
   * happens inside.
   */
  async lockById(paymentId: string, merchantId: string): Promise<PaymentRow | null> {
    const res = await this.db.query<PaymentRow>(
      "SELECT * FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE",
      [paymentId, merchantId],
    );
    return res.rows[0] ?? null;
  }

  /** Lock without the tenant filter -- internal workers only. */
  async lockByIdInternal(paymentId: string): Promise<PaymentRow | null> {
    const res = await this.db.query<PaymentRow>("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [
      paymentId,
    ]);
    return res.rows[0] ?? null;
  }

  async findById(paymentId: string, merchantId: string): Promise<PaymentRow | null> {
    const res = await this.db.query<PaymentRow>(
      "SELECT * FROM payments WHERE id = $1 AND merchant_id = $2",
      [paymentId, merchantId],
    );
    return res.rows[0] ?? null;
  }

  async lockByPspReference(pspReference: string): Promise<PaymentRow | null> {
    const res = await this.db.query<PaymentRow>(
      "SELECT * FROM payments WHERE psp_reference = $1 FOR UPDATE",
      [pspReference],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Status change with an optimistic-concurrency guard on `version`.
   *
   * The WHERE clause makes the update itself atomic: if another transaction
   * changed the row since we read it, 0 rows are updated and the caller knows
   * to abort. Combined with FOR UPDATE above this is belt and braces -- and the
   * version column also gives clients an ETag-style handle later.
   */
  async updateStatus(input: {
    paymentId: string;
    expectedVersion: number;
    status: PaymentStatus;
    set?: Record<string, string | number | null>;
  }): Promise<PaymentRow | null> {
    const assignments: string[] = ["status = $3", "version = version + 1", "updated_at = now()"];
    const params: unknown[] = [input.paymentId, input.expectedVersion, input.status];
    let index = 4;
    for (const [column, value] of Object.entries(input.set ?? {})) {
      // Column names come from code, never from user input.
      assignments.push(`${column} = $${index}`);
      params.push(value);
      index += 1;
    }
    const res = await this.db.query<PaymentRow>(
      `UPDATE payments SET ${assignments.join(", ")}
        WHERE id = $1 AND version = $2
        RETURNING *`,
      params,
    );
    return res.rows[0] ?? null;
  }

  /** Appends to the audit trail. Never updates or deletes (enforced by trigger). */
  async appendEvent(input: {
    paymentId: string;
    merchantId: string;
    eventType: string;
    fromStatus?: PaymentStatus | null;
    toStatus?: PaymentStatus | null;
    detail?: Record<string, unknown>;
    correlationId?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO payment_events
         (payment_id, merchant_id, event_type, from_status, to_status, detail, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.paymentId,
        input.merchantId,
        input.eventType,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        input.detail ?? {},
        input.correlationId ?? null,
      ],
    );
  }

  async listEvents(paymentId: string, merchantId: string): Promise<PaymentEventRow[]> {
    const res = await this.db.query<PaymentEventRow>(
      `SELECT id, payment_id, event_type, from_status, to_status, detail, created_at
         FROM payment_events
        WHERE payment_id = $1 AND merchant_id = $2
        ORDER BY id ASC`,
      [paymentId, merchantId],
    );
    return res.rows;
  }

  async listForMerchant(merchantId: string, limit: number): Promise<PaymentRow[]> {
    const res = await this.db.query<PaymentRow>(
      "SELECT * FROM payments WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
      [merchantId, limit],
    );
    return res.rows;
  }

  /** Every PSP call we make is recorded, including failures. */
  async recordPspTransaction(input: {
    paymentId: string;
    operation: string;
    ourReference: string;
    pspRef?: string | null;
    request: Record<string, unknown>;
    response?: unknown;
    httpStatus?: number | null;
    outcome: "SUCCESS" | "DECLINED" | "TIMEOUT" | "ERROR";
    latencyMs?: number | null;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO psp_transactions
         (payment_id, operation, our_reference, psp_ref, request, response,
          http_status, outcome, latency_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.paymentId,
        input.operation,
        input.ourReference,
        input.pspRef ?? null,
        input.request,
        input.response === undefined ? null : input.response,
        input.httpStatus ?? null,
        input.outcome,
        input.latencyMs ?? null,
        input.errorMessage ?? null,
      ],
    );
  }

  /**
   * Reserves refundable amount for an in-flight refund. Returns null when the
   * version moved or the CHECK constraint refused (refunded + reserved would
   * exceed captured) -- both mean "someone else is already refunding".
   */
  async reserveRefund(paymentId: string, expectedVersion: number, amount: bigint): Promise<PaymentRow | null> {
    try {
      const res = await this.db.query<PaymentRow>(
        `UPDATE payments
            SET refund_reserved_minor = refund_reserved_minor + $3,
                refund_reserved_at    = now(),
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND version = $2
          RETURNING *`,
        [paymentId, expectedVersion, amount.toString()],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      // check_violation == the DB proved the reservation would over-refund.
      if ((err as { code?: string }).code === "23514") return null;
      throw err;
    }
  }

  /** Gives a reservation back after the provider definitively refused. */
  async releaseRefundReservation(paymentId: string, amount: bigint): Promise<void> {
    await this.db.query(
      `UPDATE payments
          SET refund_reserved_minor = GREATEST(refund_reserved_minor - $2, 0),
              refund_reserved_at    = CASE WHEN refund_reserved_minor - $2 <= 0 THEN NULL ELSE refund_reserved_at END,
              version = version + 1,
              updated_at = now()
        WHERE id = $1`,
      [paymentId, amount.toString()],
    );
  }

  /** Consumes the reservation and records the refund in one atomic step. */
  async settleRefund(
    paymentId: string,
    expectedVersion: number,
    reservedAmount: bigint,
    refundedTotal: bigint,
    status: PaymentStatus,
  ): Promise<PaymentRow | null> {
    const res = await this.db.query<PaymentRow>(
      `UPDATE payments
          SET refund_reserved_minor = GREATEST(refund_reserved_minor - $3, 0),
              refund_reserved_at    = CASE WHEN refund_reserved_minor - $3 <= 0 THEN NULL ELSE refund_reserved_at END,
              refunded_amount = $4,
              status = $5,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING *`,
      [paymentId, expectedVersion, reservedAmount.toString(), refundedTotal.toString(), status],
    );
    return res.rows[0] ?? null;
  }

  async countRefunds(paymentId: string): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      "SELECT count(*) FROM ledger_transactions WHERE payment_id = $1 AND kind = 'REFUND'",
      [paymentId],
    );
    return Number(res.rows[0]?.count ?? "0");
  }
}
