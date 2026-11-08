import type { Pool, PoolClient } from "pg";
import { newId } from "../common/ids";
import type {
  AccountType,
  AccountView,
  LedgerEntryView,
  PostingRequest,
  PostingResult,
} from "./ledger.types";

export type AccountRow = {
  id: string;
  merchant_id: string | null;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  is_system: boolean;
};

export class LedgerRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  /**
   * Inserts the journal header. If this exact business event was already
   * posted, the unique index (payment_id, kind, sequence) makes the insert a
   * no-op and we return posted=false -- the retry-safe path.
   */
  async insertTransaction(request: PostingRequest): Promise<PostingResult | null> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO ledger_transactions
         (id, kind, merchant_id, payment_id, payout_id, sequence, currency,
          amount_minor, description, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        newId(),
        request.kind,
        request.merchantId,
        request.paymentId ?? null,
        request.payoutId ?? null,
        request.sequence,
        request.currency,
        request.amount.toString(),
        request.description,
        request.correlationId ?? null,
      ],
    );
    const row = res.rows[0];
    return row ? { transactionId: row.id, posted: true } : null;
  }

  async insertEntries(transactionId: string, currency: string, request: PostingRequest): Promise<void> {
    if (request.lines.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    request.lines.forEach((line, index) => {
      const base = index * 5;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      params.push(transactionId, line.accountId, line.direction, line.amount.toString(), currency);
    });
    await this.db.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency)
       VALUES ${values.join(", ")}`,
      params,
    );
  }

  async findAccount(merchantId: string, code: string, currency: string): Promise<AccountRow | null> {
    const res = await this.db.query<AccountRow>(
      `SELECT * FROM accounts
        WHERE code = $1 AND currency = $2
          AND (merchant_id = $3 OR (merchant_id IS NULL AND is_system))`,
      [code, currency, merchantId],
    );
    return res.rows[0] ?? null;
  }

  async findAccountById(accountId: string): Promise<AccountRow | null> {
    const res = await this.db.query<AccountRow>("SELECT * FROM accounts WHERE id = $1", [accountId]);
    return res.rows[0] ?? null;
  }

  /**
   * Tenant-filtered account lookup: the repository cannot express a cross-tenant
   * read. System accounts (PSP_CLEARING, FEE_REVENUE) are excluded on purpose --
   * a merchant must not be able to read platform-wide balances through its own
   * API, even though those accounts are involved in its postings.
   */
  async findAccountForMerchant(accountId: string, merchantId: string): Promise<AccountRow | null> {
    const res = await this.db.query<AccountRow>(
      "SELECT * FROM accounts WHERE id = $1 AND merchant_id = $2 AND is_system = false",
      [accountId, merchantId],
    );
    return res.rows[0] ?? null;
  }

  async listAccounts(merchantId: string): Promise<AccountView[]> {
    const res = await this.db.query<{
      id: string;
      code: string;
      type: AccountType;
      currency: string;
      is_system: boolean;
      balance_minor: string;
    }>(
      `SELECT account_id AS id, code, type, currency, is_system, balance_minor
         FROM account_balances
        WHERE merchant_id = $1
        ORDER BY code, currency`,
      [merchantId],
    );
    return res.rows.map((row) => ({ ...row, balance_minor: row.balance_minor.toString() }));
  }

  async getBalance(accountId: string): Promise<bigint> {
    const res = await this.db.query<{ balance_minor: string }>(
      "SELECT balance_minor FROM account_balances WHERE account_id = $1",
      [accountId],
    );
    return BigInt(res.rows[0]?.balance_minor ?? "0");
  }

  /**
   * Statement with keyset pagination: newest first, `cursor` is the last id seen.
   * OFFSET pagination would get slower and skip/duplicate rows under concurrent
   * inserts, which matters for an append-only ledger.
   */
  async listEntries(
    accountId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ entries: LedgerEntryView[]; hasMore: boolean }> {
    // Fetch one extra row: that is the only reliable way to know whether a
    // next page exists without a COUNT(*) over the whole account.
    const fetchLimit = options.limit + 1;
    const params: unknown[] = [accountId, fetchLimit];
    let cursorClause = "";
    if (options.cursor) {
      params.push(options.cursor);
      cursorClause = ` AND e.id < $3`;
    }
    const res = await this.db.query<{
      id: string;
      transaction_id: string;
      account_id: string;
      direction: "DEBIT" | "CREDIT";
      amount_minor: string;
      currency: string;
      created_at: Date;
      kind: LedgerEntryView["kind"];
      description: string;
      payment_id: string | null;
      payout_id: string | null;
    }>(
      `SELECT e.id, e.transaction_id, e.account_id, e.direction, e.amount_minor, e.currency,
              e.created_at, t.kind, t.description, t.payment_id, t.payout_id
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1
        ${cursorClause}
        ORDER BY e.id DESC
        LIMIT $2`,
      params,
    );
    const hasMore = res.rows.length > options.limit;
    const page = hasMore ? res.rows.slice(0, options.limit) : res.rows;
    return {
      hasMore,
      entries: page.map((row) => ({
        ...row,
        amount_minor: row.amount_minor.toString(),
        created_at: row.created_at.toISOString(),
      })),
    };
  }

  /** For the nightly invariant check: any transaction whose sides disagree. */
  async findUnbalancedTransactions(): Promise<{ id: string; debits: string; credits: string }[]> {
    const res = await this.db.query<{ id: string; debits: string; credits: string }>(
      `SELECT t.id,
              COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT'), 0)  AS debits,
              COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'CREDIT'), 0) AS credits
         FROM ledger_transactions t
         LEFT JOIN ledger_entries e ON e.transaction_id = t.id
        GROUP BY t.id
       HAVING COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT'), 0)
            <> COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'CREDIT'), 0)`,
    );
    return res.rows;
  }
}
