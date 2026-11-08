import { PoolClient } from "pg";
import { pool } from "../common/db";
import { ConflictError } from "../common/errors";
import { Account } from "../merchant/merchant.types";
import { Payout, PayoutDestination, PayoutStatus } from "./payout.types";

type DbExecutor = PoolClient | typeof pool;

export class PayoutRepository {
  /**
   * Locks the merchant's account row for update using PostgreSQL SELECT ... FOR UPDATE.
   * Serializes concurrent payout requests on the same account to prevent race conditions.
   */
  async lockMerchantAccountForUpdate(
    client: PoolClient,
    merchantId: string,
    accountName = "MERCHANT_PAYABLE",
    currency = "USD"
  ): Promise<Account | null> {
    const sql = `
      SELECT id, merchant_id, type, name, currency, balance, created_at, updated_at
      FROM accounts
      WHERE merchant_id = $1 AND name = $2 AND currency = $3
      FOR UPDATE
    `;
    const res = await client.query(sql, [merchantId, accountName, currency]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      type: r.type,
      name: r.name,
      currency: r.currency,
      balance: r.balance,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async createPayout(
    merchantId: string,
    amount: bigint,
    currency: string,
    destination: PayoutDestination,
    client: PoolClient
  ): Promise<Payout> {
    const sql = `
      INSERT INTO payouts (merchant_id, amount, currency, status, destination, version)
      VALUES ($1, $2, $3, 'PENDING', $4, 1)
      RETURNING id, merchant_id, amount, currency, status, destination, version, created_at, updated_at
    `;
    const res = await client.query(sql, [merchantId, amount, currency, JSON.stringify(destination)]);
    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      destination: r.destination,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async updatePayoutStatus(
    payoutId: string,
    expectedStatus: PayoutStatus,
    newStatus: PayoutStatus,
    client: PoolClient
  ): Promise<Payout> {
    const sql = `
      UPDATE payouts
      SET status = $1, version = version + 1, updated_at = NOW()
      WHERE id = $2 AND status = $3
      RETURNING id, merchant_id, amount, currency, status, destination, version, created_at, updated_at
    `;
    const res = await client.query(sql, [newStatus, payoutId, expectedStatus]);
    if (res.rows.length === 0) {
      throw new ConflictError(
        `Failed to transition payout '${payoutId}' from '${expectedStatus}' to '${newStatus}'. Current status may have changed concurrently.`
      );
    }
    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      destination: r.destination,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async findByMerchantAndId(
    merchantId: string,
    payoutId: string,
    executor: DbExecutor = pool
  ): Promise<Payout | null> {
    const sql = `
      SELECT id, merchant_id, amount, currency, status, destination, version, created_at, updated_at
      FROM payouts
      WHERE id = $1 AND merchant_id = $2
    `;
    const res = await executor.query(sql, [payoutId, merchantId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      destination: r.destination,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async listByMerchant(
    merchantId: string,
    limit = 50,
    executor: DbExecutor = pool
  ): Promise<Payout[]> {
    const sql = `
      SELECT id, merchant_id, amount, currency, status, destination, version, created_at, updated_at
      FROM payouts
      WHERE merchant_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const res = await executor.query(sql, [merchantId, limit]);
    return res.rows.map((r) => ({
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      destination: r.destination,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}

export const payoutRepository = new PayoutRepository();
