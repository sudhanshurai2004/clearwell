import { PoolClient } from "pg";
import { pool } from "../common/db";
import { Merchant, ApiKey, Account } from "./merchant.types";

type DbExecutor = PoolClient | typeof pool;

export class MerchantRepository {
  async createMerchant(
    name: string,
    email: string,
    executor: DbExecutor = pool
  ): Promise<Merchant> {
    const sql = `
      INSERT INTO merchants (name, email)
      VALUES ($1, $2)
      RETURNING id, name, email, status, created_at, updated_at
    `;
    const res = await executor.query(sql, [name, email]);
    const row = res.rows[0];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findById(id: string, executor: DbExecutor = pool): Promise<Merchant | null> {
    const sql = `
      SELECT id, name, email, status, created_at, updated_at
      FROM merchants
      WHERE id = $1
    `;
    const res = await executor.query(sql, [id]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findByEmail(email: string, executor: DbExecutor = pool): Promise<Merchant | null> {
    const sql = `
      SELECT id, name, email, status, created_at, updated_at
      FROM merchants
      WHERE email = $1
    `;
    const res = await executor.query(sql, [email]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createApiKey(
    merchantId: string,
    keyPrefix: string,
    keyHash: string,
    scopes: string[],
    executor: DbExecutor = pool
  ): Promise<ApiKey> {
    const sql = `
      INSERT INTO api_keys (merchant_id, key_prefix, key_hash, scopes)
      VALUES ($1, $2, $3, $4)
      RETURNING id, merchant_id, key_prefix, key_hash, scopes, revoked_at, created_at
    `;
    const res = await executor.query(sql, [merchantId, keyPrefix, keyHash, scopes]);
    const row = res.rows[0];
    return {
      id: row.id,
      merchantId: row.merchant_id,
      keyPrefix: row.key_prefix,
      keyHash: row.key_hash,
      scopes: row.scopes,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }

  async findActiveApiKeyByPrefix(
    prefix: string,
    executor: DbExecutor = pool
  ): Promise<{ apiKey: ApiKey; merchant: Merchant } | null> {
    const sql = `
      SELECT 
        k.id AS key_id, k.merchant_id, k.key_prefix, k.key_hash, k.scopes, k.revoked_at, k.created_at AS key_created_at,
        m.id AS m_id, m.name AS m_name, m.email AS m_email, m.status AS m_status, m.created_at AS m_created_at, m.updated_at AS m_updated_at
      FROM api_keys k
      JOIN merchants m ON m.id = k.merchant_id
      WHERE k.key_prefix = $1 AND k.revoked_at IS NULL AND m.status = 'ACTIVE'
    `;
    const res = await executor.query(sql, [prefix]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      apiKey: {
        id: row.key_id,
        merchantId: row.merchant_id,
        keyPrefix: row.key_prefix,
        keyHash: row.key_hash,
        scopes: row.scopes,
        revokedAt: row.revoked_at,
        createdAt: row.key_created_at,
      },
      merchant: {
        id: row.m_id,
        name: row.m_name,
        email: row.m_email,
        status: row.m_status,
        createdAt: row.m_created_at,
        updatedAt: row.m_updated_at,
      },
    };
  }

  async createAccount(
    merchantId: string | null,
    type: "ASSET" | "LIABILITY" | "REVENUE",
    name: string,
    currency: string,
    executor: DbExecutor = pool
  ): Promise<Account> {
    const sql = `
      INSERT INTO accounts (merchant_id, type, name, currency, balance)
      VALUES ($1, $2, $3, $4, 0)
      RETURNING id, merchant_id, type, name, currency, balance, created_at, updated_at
    `;
    const res = await executor.query(sql, [merchantId, type, name, currency]);
    const row = res.rows[0];
    return {
      id: row.id,
      merchantId: row.merchant_id,
      type: row.type,
      name: row.name,
      currency: row.currency,
      balance: row.balance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findAccountsByMerchantId(
    merchantId: string,
    executor: DbExecutor = pool
  ): Promise<Account[]> {
    const sql = `
      SELECT id, merchant_id, type, name, currency, balance, created_at, updated_at
      FROM accounts
      WHERE merchant_id = $1
      ORDER BY created_at ASC
    `;
    const res = await executor.query(sql, [merchantId]);
    return res.rows.map((row) => ({
      id: row.id,
      merchantId: row.merchant_id,
      type: row.type,
      name: row.name,
      currency: row.currency,
      balance: row.balance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}

export const merchantRepository = new MerchantRepository();
