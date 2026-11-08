import type { Pool, PoolClient } from "pg";
import { newId } from "../common/ids";

export type MerchantRow = {
  id: string;
  name: string;
  email: string;
  status: string;
  default_currency: string;
  created_at: Date;
  updated_at: Date;
};

export type ApiKeyRow = {
  id: string;
  merchant_id: string;
  key_prefix: string;
  key_hash: string;
  label: string;
  scopes: string[];
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

export type AccountRow = {
  id: string;
  merchant_id: string | null;
  code: string;
  name: string;
  type: string;
  currency: string;
  is_system: boolean;
};

/**
 * Data access for the merchant module. Every method takes the query client so
 * the caller decides whether it runs in a transaction.
 */
export class MerchantRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  async insertMerchant(input: {
    name: string;
    email: string;
    defaultCurrency: string;
  }): Promise<MerchantRow> {
    const res = await this.db.query<MerchantRow>(
      `INSERT INTO merchants (id, name, email, default_currency)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [newId(), input.name, input.email, input.defaultCurrency],
    );
    return res.rows[0] as MerchantRow;
  }

  async findMerchantById(merchantId: string): Promise<MerchantRow | null> {
    const res = await this.db.query<MerchantRow>("SELECT * FROM merchants WHERE id = $1", [
      merchantId,
    ]);
    return res.rows[0] ?? null;
  }

  async insertApiKey(input: {
    merchantId: string;
    keyPrefix: string;
    keyHash: string;
    label: string;
    scopes: readonly string[];
  }): Promise<ApiKeyRow> {
    const res = await this.db.query<ApiKeyRow>(
      `INSERT INTO api_keys (id, merchant_id, key_prefix, key_hash, label, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [newId(), input.merchantId, input.keyPrefix, input.keyHash, input.label, input.scopes],
    );
    return res.rows[0] as ApiKeyRow;
  }

  /** Auth lookup: one indexed hit on the public prefix. */
  async findApiKeyByPrefix(prefix: string): Promise<(ApiKeyRow & { merchant_status: string }) | null> {
    const res = await this.db.query<ApiKeyRow & { merchant_status: string }>(
      `SELECT k.*, m.status AS merchant_status
         FROM api_keys k
         JOIN merchants m ON m.id = k.merchant_id
        WHERE k.key_prefix = $1`,
      [prefix],
    );
    return res.rows[0] ?? null;
  }

  async touchApiKeyLastUsed(apiKeyId: string): Promise<void> {
    await this.db.query(
      `UPDATE api_keys
          SET last_used_at = now()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
      [apiKeyId],
    );
  }

  /**
   * Every merchant gets its own MERCHANT_PAYABLE account per currency.
   * ON CONFLICT DO NOTHING makes this idempotent: two concurrent creates cannot
   * produce two payable accounts (the partial unique index backs it up).
   */
  async ensureMerchantPayableAccount(merchantId: string, currency: string): Promise<AccountRow> {
    await this.db.query(
      `INSERT INTO accounts (id, merchant_id, code, name, type, currency, is_system)
       VALUES ($1, $2, 'MERCHANT_PAYABLE', 'Merchant payable', 'LIABILITY', $3, false)
       ON CONFLICT (merchant_id, code, currency) WHERE merchant_id IS NOT NULL DO NOTHING`,
      [newId(), merchantId, currency],
    );
    const res = await this.db.query<AccountRow>(
      `SELECT * FROM accounts
        WHERE merchant_id = $1 AND code = 'MERCHANT_PAYABLE' AND currency = $2`,
      [merchantId, currency],
    );
    return res.rows[0] as AccountRow;
  }
}
