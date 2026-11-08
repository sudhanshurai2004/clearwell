import { PoolClient } from "pg";
import { pool } from "../common/db";
import { Account } from "../merchant/merchant.types";
import {
  LedgerTransaction,
  LedgerEntry,
  PostTransactionInput,
  PostEntryInput,
  AccountBalance,
  ReferenceType,
} from "./ledger.types";

type DbExecutor = PoolClient | typeof pool;

export class LedgerRepository {
  async findSystemAccount(
    name: "PSP_CLEARING" | "FEE_REVENUE",
    currency: string,
    executor: DbExecutor = pool
  ): Promise<Account | null> {
    const sql = `
      SELECT id, merchant_id, type, name, currency, balance, created_at, updated_at
      FROM accounts
      WHERE merchant_id IS NULL AND name = $1 AND currency = $2
      LIMIT 1
    `;
    const res = await executor.query(sql, [name, currency]);
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

  async findMerchantAccount(
    merchantId: string,
    name: "MERCHANT_PAYABLE",
    currency: string,
    executor: DbExecutor = pool
  ): Promise<Account | null> {
    const sql = `
      SELECT id, merchant_id, type, name, currency, balance, created_at, updated_at
      FROM accounts
      WHERE merchant_id = $1 AND name = $2 AND currency = $3
      LIMIT 1
    `;
    const res = await executor.query(sql, [merchantId, name, currency]);
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

  async findTransactionByReference(
    referenceId: string,
    referenceType: ReferenceType,
    executor: DbExecutor = pool
  ): Promise<LedgerTransaction | null> {
    const sql = `
      SELECT id, merchant_id, reference_id, reference_type, description, posted_at, created_at
      FROM ledger_transactions
      WHERE reference_id = $1 AND reference_type = $2
    `;
    const res = await executor.query(sql, [referenceId, referenceType]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      merchantId: r.merchant_id,
      referenceId: r.reference_id,
      referenceType: r.reference_type,
      description: r.description,
      postedAt: r.posted_at,
      createdAt: r.created_at,
    };
  }

  async createTransaction(
    input: PostTransactionInput,
    client: PoolClient
  ): Promise<{ transaction: LedgerTransaction; isNew: boolean }> {
    const insertSql = `
      INSERT INTO ledger_transactions (merchant_id, reference_id, reference_type, description)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (reference_id, reference_type) DO NOTHING
      RETURNING id, merchant_id, reference_id, reference_type, description, posted_at, created_at
    `;
    const res = await client.query(insertSql, [
      input.merchantId,
      input.referenceId,
      input.referenceType,
      input.description || null,
    ]);

    if (res.rows.length > 0) {
      const r = res.rows[0];
      return {
        transaction: {
          id: r.id,
          merchantId: r.merchant_id,
          referenceId: r.reference_id,
          referenceType: r.reference_type,
          description: r.description,
          postedAt: r.posted_at,
          createdAt: r.created_at,
        },
        isNew: true,
      };
    }

    // Existing transaction (idempotent retry)
    const existing = await this.findTransactionByReference(
      input.referenceId,
      input.referenceType,
      client
    );
    if (!existing) {
      throw new Error("Failed to retrieve existing ledger transaction");
    }
    return { transaction: existing, isNew: false };
  }

  async createEntries(
    transactionId: string,
    entries: PostEntryInput[],
    client: PoolClient
  ): Promise<LedgerEntry[]> {
    const results: LedgerEntry[] = [];
    const sql = `
      INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, currency)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, transaction_id, account_id, direction, amount, currency, created_at
    `;

    for (const entry of entries) {
      const res = await client.query(sql, [
        transactionId,
        entry.accountId,
        entry.direction,
        entry.amount,
        entry.currency,
      ]);
      const r = res.rows[0];
      results.push({
        id: r.id,
        transactionId: r.transaction_id,
        accountId: r.account_id,
        direction: r.direction,
        amount: r.amount,
        currency: r.currency,
        createdAt: r.created_at,
      });
    }

    return results;
  }

  async getAccountBalance(
    accountId: string,
    executor: DbExecutor = pool
  ): Promise<AccountBalance | null> {
    const sql = `
      SELECT 
        a.id, a.name, a.type, a.currency,
        COALESCE(
          SUM(
            CASE 
              WHEN a.type = 'ASSET' THEN (CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END)
              ELSE (CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END)
            END
          ), 
          0
        ) AS balance
      FROM accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.id = $1
      GROUP BY a.id, a.name, a.type, a.currency
    `;
    const res = await executor.query(sql, [accountId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      accountId: r.id,
      accountName: r.name,
      accountType: r.type,
      currency: r.currency,
      balance: r.balance,
    };
  }

  async getTransactionWithEntries(
    transactionId: string,
    executor: DbExecutor = pool
  ): Promise<{ transaction: LedgerTransaction; entries: LedgerEntry[] } | null> {
    const txSql = `
      SELECT id, merchant_id, reference_id, reference_type, description, posted_at, created_at
      FROM ledger_transactions
      WHERE id = $1
    `;
    const txRes = await executor.query(txSql, [transactionId]);
    if (txRes.rows.length === 0) return null;
    const txRow = txRes.rows[0];

    const entriesSql = `
      SELECT id, transaction_id, account_id, direction, amount, currency, created_at
      FROM ledger_entries
      WHERE transaction_id = $1
      ORDER BY created_at ASC
    `;
    const entriesRes = await executor.query(entriesSql, [transactionId]);

    return {
      transaction: {
        id: txRow.id,
        merchantId: txRow.merchant_id,
        referenceId: txRow.reference_id,
        referenceType: txRow.reference_type,
        description: txRow.description,
        postedAt: txRow.posted_at,
        createdAt: txRow.created_at,
      },
      entries: entriesRes.rows.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        accountId: r.account_id,
        direction: r.direction,
        amount: r.amount,
        currency: r.currency,
        createdAt: r.created_at,
      })),
    };
  }
}

export const ledgerRepository = new LedgerRepository();
