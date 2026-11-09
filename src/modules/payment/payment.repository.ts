import { PoolClient } from "pg";
import { pool } from "../common/db";
import { ConflictError } from "../common/errors";
import { Payment, PaymentEvent, PaymentStatus } from "./payment.types";

type DbExecutor = PoolClient | typeof pool;

export class PaymentRepository {
  async createPayment(
    merchantId: string,
    amount: bigint,
    currency: string,
    executor: DbExecutor = pool
  ): Promise<Payment> {
    const sql = `
      INSERT INTO payments (merchant_id, amount, currency, status, authorized_amount, captured_amount, refunded_amount, version)
      VALUES ($1, $2, $3, 'CREATED', 0, 0, 0, 1)
      RETURNING id, merchant_id, amount, currency, status, authorized_amount, captured_amount, refunded_amount, psp_ref, version, created_at, updated_at
    `;
    const res = await executor.query(sql, [merchantId, amount, currency]);
    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      authorizedAmount: r.authorized_amount,
      capturedAmount: r.captured_amount,
      refundedAmount: r.refunded_amount,
      pspRef: r.psp_ref,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async updatePaymentState(
    paymentId: string,
    expectedStatus: PaymentStatus,
    newStatus: PaymentStatus,
    updates: {
      authorizedAmount?: bigint;
      capturedAmount?: bigint;
      refundedAmount?: bigint;
      pspRef?: string;
    } = {},
    client: PoolClient
  ): Promise<Payment> {
    const sql = `
      UPDATE payments
      SET 
        status = $1,
        authorized_amount = COALESCE($2, authorized_amount),
        captured_amount = COALESCE($3, captured_amount),
        refunded_amount = COALESCE($4, refunded_amount),
        psp_ref = COALESCE($5, psp_ref),
        version = version + 1,
        updated_at = NOW()
      WHERE id = $6 AND status = $7
      RETURNING id, merchant_id, amount, currency, status, authorized_amount, captured_amount, refunded_amount, psp_ref, version, created_at, updated_at
    `;

    const res = await client.query(sql, [
      newStatus,
      updates.authorizedAmount ?? null,
      updates.capturedAmount ?? null,
      updates.refundedAmount ?? null,
      updates.pspRef ?? null,
      paymentId,
      expectedStatus,
    ]);

    if (res.rows.length === 0) {
      throw new ConflictError(
        `Failed to transition payment '${paymentId}' from '${expectedStatus}' to '${newStatus}'. Current status may have changed concurrently.`
      );
    }

    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      authorizedAmount: r.authorized_amount,
      capturedAmount: r.captured_amount,
      refundedAmount: r.refunded_amount,
      pspRef: r.psp_ref,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async recordEvent(
    paymentId: string,
    previousStatus: PaymentStatus | null,
    newStatus: PaymentStatus,
    eventType: string,
    payload: Record<string, unknown> = {},
    client: PoolClient
  ): Promise<PaymentEvent> {
    const sql = `
      INSERT INTO payment_events (payment_id, previous_status, new_status, event_type, payload)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, payment_id, previous_status, new_status, event_type, payload, created_at
    `;
    const res = await client.query(sql, [
      paymentId,
      previousStatus,
      newStatus,
      eventType,
      JSON.stringify(payload),
    ]);
    const r = res.rows[0];
    return {
      id: r.id,
      paymentId: r.payment_id,
      previousStatus: r.previous_status,
      newStatus: r.new_status,
      eventType: r.event_type,
      payload: r.payload,
      createdAt: r.created_at,
    };
  }

  async findById(paymentId: string, executor: DbExecutor = pool): Promise<Payment | null> {
    const sql = `
      SELECT id, merchant_id, amount, currency, status, authorized_amount, captured_amount, refunded_amount, psp_ref, version, created_at, updated_at
      FROM payments
      WHERE id = $1
    `;
    const res = await executor.query(sql, [paymentId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      authorizedAmount: r.authorized_amount,
      capturedAmount: r.captured_amount,
      refundedAmount: r.refunded_amount,
      pspRef: r.psp_ref,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async findByMerchantAndId(
    merchantId: string,
    paymentId: string,
    executor: DbExecutor = pool
  ): Promise<Payment | null> {
    const sql = `
      SELECT id, merchant_id, amount, currency, status, authorized_amount, captured_amount, refunded_amount, psp_ref, version, created_at, updated_at
      FROM payments
      WHERE id = $1 AND merchant_id = $2
    `;
    const res = await executor.query(sql, [paymentId, merchantId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      authorizedAmount: r.authorized_amount,
      capturedAmount: r.captured_amount,
      refundedAmount: r.refunded_amount,
      pspRef: r.psp_ref,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async findByStatus(
    status: PaymentStatus,
    limit = 25,
    executor: DbExecutor = pool
  ): Promise<Payment[]> {
    const sql = `
      SELECT id, merchant_id, amount, currency, status, authorized_amount, captured_amount, refunded_amount, psp_ref, version, created_at, updated_at
      FROM payments
      WHERE status = $1
      ORDER BY updated_at ASC
      LIMIT $2
    `;
    const res = await executor.query(sql, [status, limit]);
    return res.rows.map((r) => ({
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      authorizedAmount: r.authorized_amount,
      capturedAmount: r.captured_amount,
      refundedAmount: r.refunded_amount,
      pspRef: r.psp_ref,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}

export const paymentRepository = new PaymentRepository();
