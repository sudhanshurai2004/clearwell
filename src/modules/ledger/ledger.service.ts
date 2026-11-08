import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../common/db";
import { AppError } from "../common/errors";
import { flatFeeBps, PLATFORM_FEE_BPS } from "../common/money";
import { LedgerRepository } from "./ledger.repository";
import {
  AccountCode,
  Direction,
  LedgerTransactionKind,
  type AccountType,
  type LedgerEntryView,
  type PostingLine,
  type PostingResult,
} from "./ledger.types";

export type CapturePosting = {
  merchantId: string;
  paymentId: string;
  currency: string;
  /** Gross amount captured. Net + fee == gross, always. */
  gross: bigint;
  correlationId?: string;
};

export type RefundPosting = {
  merchantId: string;
  paymentId: string;
  currency: string;
  /** Refund amount as requested by the merchant. */
  refund: bigint;
  /** Portion of the 2% fee being returned to the merchant (already computed). */
  feeReversal: bigint;
  /** 1-based index of this refund within the payment. */
  sequence: number;
  correlationId?: string;
};

export type PayoutPosting = {
  merchantId: string;
  payoutId: string;
  currency: string;
  amount: bigint;
  correlationId?: string;
};

/**
 * THE LEDGER.
 *
 * The only module allowed to write ledger_transactions / ledger_entries.
 * Everything here is intentionally boring and explicit: no generic "post
 * anything" API, only the four business events the system actually has.
 *
 * Every posting method takes `client`, so the caller can put the posting in the
 * SAME transaction as the state change and the outbox row. That is the
 * requirement "ledger posting, status change and outbox event commit together".
 */
export class LedgerService {
  constructor(private readonly pool: Pool) {}

  // ------------------------------------------------------------------ capture
  /**
   * Capture of `gross` money from the provider:
   *
   *   DEBIT  PSP_CLEARING        gross   (cash arrived at the provider)
   *   CREDIT MERCHANT_PAYABLE    net     (we now owe the merchant)
   *   CREDIT FEE_REVENUE         fee     (we earned the 2%)
   *
   * Why a debit to PSP_CLEARING? PSP_CLEARING is an ASSET: it represents money
   * held on our behalf at the provider. Assets increase on the debit side.
   * MERCHANT_PAYABLE is a LIABILITY (we owe the merchant) and FEE_REVENUE is
   * REVENUE: both increase on the credit side.
   */
  async postCapture(client: PoolClient, capture: CapturePosting): Promise<PostingResult> {
    if (capture.gross <= 0n) throw AppError.internal("capture amount must be positive");
    const fee = flatFeeBps(capture.gross, PLATFORM_FEE_BPS);
    const net = capture.gross - fee;

    const clearing = await this.requireAccount(client, capture.merchantId, AccountCode.PSP_CLEARING, capture.currency);
    const payable = await this.requireMerchantAccount(client, capture.merchantId, capture.currency);

    const lines: PostingLine[] = [
      { accountId: clearing.id, direction: Direction.DEBIT, amount: capture.gross },
      { accountId: payable.id, direction: Direction.CREDIT, amount: net },
      // A zero-fee capture (tiny amounts, floor rounding) would insert amount 0,
      // which the CHECK constraint rejects. Skip the line instead: the entry is
      // still balanced and the fee is genuinely zero.
      ...(fee > 0n
        ? [{ accountId: await this.requireFeeAccount(client, capture.currency), direction: Direction.CREDIT, amount: fee } satisfies PostingLine]
        : []),
    ];

    return this.post(client, {
      kind: LedgerTransactionKind.CAPTURE,
      merchantId: capture.merchantId,
      paymentId: capture.paymentId,
      sequence: 1,
      currency: capture.currency,
      amount: capture.gross,
      description: `Capture ${capture.paymentId}`,
      correlationId: capture.correlationId,
      lines,
    });
  }

  /**
   * Refund of `refund`, reversing the proportional fee:
   *
   *   DEBIT  MERCHANT_PAYABLE    refund - feeReversal
   *   DEBIT  FEE_REVENUE         feeReversal
   *   CREDIT PSP_CLEARING        refund
   *
   * Exactly the mirror of capture, so the three accounts end up exactly where
   * they started once the whole payment is refunded.
   *
   * `sequence` makes the posting retry-safe: refund #2 has sequence 2, so a
   * duplicate attempt to post the same refund hits the unique index.
   */
  async postRefund(client: PoolClient, refund: RefundPosting): Promise<PostingResult> {
    if (refund.refund <= 0n) throw AppError.internal("refund amount must be positive");
    if (refund.feeReversal < 0n || refund.feeReversal > refund.refund) {
      throw AppError.internal("fee reversal must be between 0 and the refund amount");
    }
    const net = refund.refund - refund.feeReversal;

    const clearing = await this.requireAccount(client, refund.merchantId, AccountCode.PSP_CLEARING, refund.currency);
    const payable = await this.requireMerchantAccount(client, refund.merchantId, refund.currency);
    const feeAccount = refund.feeReversal > 0n ? await this.requireFeeAccount(client, refund.currency) : null;

    const lines: PostingLine[] = [
      ...(net > 0n ? [{ accountId: payable.id, direction: Direction.DEBIT, amount: net } satisfies PostingLine] : []),
      ...(feeAccount ? [{ accountId: feeAccount, direction: Direction.DEBIT, amount: refund.feeReversal } satisfies PostingLine] : []),
      { accountId: clearing.id, direction: Direction.CREDIT, amount: refund.refund },
    ];

    return this.post(client, {
      kind: LedgerTransactionKind.REFUND,
      merchantId: refund.merchantId,
      paymentId: refund.paymentId,
      sequence: refund.sequence,
      currency: refund.currency,
      amount: refund.refund,
      description: `Refund #${refund.sequence} ${refund.paymentId}`,
      correlationId: refund.correlationId,
      lines,
    });
  }

  /**
   * Payout: we move the merchant's money out of our payable liability.
   *
   *   DEBIT  MERCHANT_PAYABLE    amount   (we owe less)
   *   CREDIT PSP_CLEARING        amount   (money leaves the provider account)
   *
   * The caller must have locked the payable account row and checked the
   * available balance -- see PayoutService in M6.
   */
  async postPayout(client: PoolClient, payout: PayoutPosting): Promise<PostingResult> {
    if (payout.amount <= 0n) throw AppError.internal("payout amount must be positive");
    const clearing = await this.requireAccount(client, payout.merchantId, AccountCode.PSP_CLEARING, payout.currency);
    const payable = await this.requireMerchantAccount(client, payout.merchantId, payout.currency);

    return this.post(client, {
      kind: LedgerTransactionKind.PAYOUT,
      merchantId: payout.merchantId,
      payoutId: payout.payoutId,
      sequence: 1,
      currency: payout.currency,
      amount: payout.amount,
      description: `Payout ${payout.payoutId}`,
      correlationId: payout.correlationId,
      lines: [
        { accountId: payable.id, direction: Direction.DEBIT, amount: payout.amount },
        { accountId: clearing.id, direction: Direction.CREDIT, amount: payout.amount },
      ],
    });
  }

  // ---------------------------------------------------------------- internals
  /**
   * The one place entries are written.
   *
   * App-level balance check first (friendly 500 before touching the DB), then
   * the insert. The deferred trigger is still the real guarantee: it runs at
   * COMMIT and will reject anything the app got wrong.
   */
  private async post(client: PoolClient, request: Parameters<LedgerRepository["insertTransaction"]>[0]): Promise<PostingResult> {
    assertBalanced(request.lines, request.amount);

    const repo = new LedgerRepository(client);
    const header = await repo.insertTransaction(request);
    if (header === null) {
      // Already posted: (payment_id|payout_id, kind, sequence) exists.
      // This is a no-op, NOT an error -- the retry is what we want to absorb.
      return { transactionId: "", posted: false };
    }
    await repo.insertEntries(header.transactionId, request.currency, request);
    return header;
  }

  private async requireAccount(
    client: PoolClient,
    merchantId: string,
    code: AccountCode,
    currency: string,
  ): Promise<{ id: string }> {
    const repo = new LedgerRepository(client);
    const account = await repo.findAccount(merchantId, code, currency);
    if (!account) {
      // A missing system account is an infrastructure bug, not a client error.
      throw AppError.internal(`Account ${code}/${currency} is not configured`);
    }
    return { id: account.id };
  }

  private async requireMerchantAccount(
    client: PoolClient,
    merchantId: string,
    currency: string,
  ): Promise<{ id: string }> {
    const repo = new LedgerRepository(client);
    const account = await repo.findAccount(merchantId, AccountCode.MERCHANT_PAYABLE, currency);
    if (!account) throw AppError.internal(`Merchant ${merchantId} has no MERCHANT_PAYABLE/${currency} account`);
    return { id: account.id };
  }

  private async requireFeeAccount(client: PoolClient, currency: string): Promise<string> {
    const repo = new LedgerRepository(client);
    const account = await repo.findAccount("", AccountCode.FEE_REVENUE, currency);
    if (!account) throw AppError.internal(`Account FEE_REVENUE/${currency} is not configured`);
    return account.id;
  }

  // ------------------------------------------------------------- read models
  async listAccounts(merchantId: string) {
    return new LedgerRepository(this.pool).listAccounts(merchantId);
  }

  async getAccountForMerchant(accountId: string, merchantId: string) {
    const repo = new LedgerRepository(this.pool);
    const account = await repo.findAccountForMerchant(accountId, merchantId);
    // Cross-tenant or unknown account -> 404, never 403 (no existence leak).
    if (!account) throw AppError.notFound("Account not found");
    return account;
  }

  async getStatement(
    accountId: string,
    merchantId: string,
    query: { limit: number; cursor?: string },
  ): Promise<{ account: { id: string; code: string; type: AccountType; currency: string; balance_minor: string }; entries: LedgerEntryView[]; next_cursor: string | null }> {
    const repo = new LedgerRepository(this.pool);
    const account = await this.getAccountForMerchant(accountId, merchantId);
    const { entries, hasMore } = await repo.listEntries(accountId, query);
    const balance = await repo.getBalance(accountId);
    return {
      account: {
        id: account.id,
        code: account.code,
        type: account.type,
        currency: account.currency,
        balance_minor: balance.toString(),
      },
      entries,
      // The cursor is the last id of THIS page, and only when the extra probe
      // row proved another page exists.
      next_cursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null,
    };
  }

  /** Runs an arbitrary posting in its own transaction (used by workers and tests). */
  async inTransaction<T>(fn: (client: PoolClient, ledger: LedgerService) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (client) => fn(client, this));
  }
}

/**
 * Application-level balance check. Sums each side and compares, so a typo in a
 * chart-of-accounts mapping fails here with a clear message instead of a
 * Postgres trigger error inside a transaction the caller cannot interpret.
 */
export function assertBalanced(lines: readonly PostingLine[], expectedAmount?: bigint): void {
  if (lines.length === 0) {
    throw AppError.internal("ledger posting must contain at least one entry");
  }
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    if (line.amount <= 0n) {
      throw AppError.internal(`ledger entry amount must be positive, got ${line.amount}`);
    }
    if (line.direction === Direction.DEBIT) debits += line.amount;
    else credits += line.amount;
  }
  if (debits !== credits) {
    throw AppError.internal(`unbalanced posting: debits=${debits} credits=${credits}`);
  }
  if (expectedAmount !== undefined && debits !== expectedAmount) {
    throw AppError.internal(
      `posting total ${debits} does not match declared amount ${expectedAmount}`,
    );
  }
}

/**
 * Proportional fee reversal for refunds.
 *
 *   reversal = floor(fee * refund / captured)          -- normal case
 *   reversal = fee - alreadyReversed                  -- final refund
 *
 * Why the special final case? Flooring each refund independently leaves a
 * residue. Example: capture 1000, fee 20, refund 333 three times.
 *   floor(20*333/1000) = 6, three times -> 18 reversed, 2 cents of fee stay
 *   with us even though the merchant refunded 999... and a 4th refund of 1
 *   would have to reverse 2. The rule we use instead: the refund that brings
 *   refunded_amount up to captured_amount reverses the whole remaining fee, so
 *   a fully refunded payment nets to exactly zero on every account.
 *
 * The result is always clamped to [0, fee - alreadyReversed], so a bug can
 * never produce a negative fee or reverse more than we ever charged.
 */
export function proportionalFeeReversal(input: {
  /** Total fee originally charged on the capture. */
  fee: bigint;
  /** Total captured amount for the payment. */
  captured: bigint;
  /** Amount of this refund. */
  refund: bigint;
  /** Refunded amount BEFORE this refund. */
  alreadyRefunded: bigint;
  /** Fee already reversed by previous refunds. */
  alreadyReversed: bigint;
}): bigint {
  const { fee, captured, refund, alreadyRefunded, alreadyReversed } = input;
  if (captured <= 0n) throw AppError.internal("captured amount must be positive");
  if (refund <= 0n) throw AppError.internal("refund amount must be positive");
  if (alreadyRefunded < 0n || alreadyReversed < 0n) throw AppError.internal("refund totals cannot be negative");
  if (refund + alreadyRefunded > captured) {
    throw AppError.internal("refunds cannot exceed the captured amount");
  }

  const remainingFee = fee - alreadyReversed < 0n ? 0n : fee - alreadyReversed;
  const isFinalRefund = alreadyRefunded + refund === captured;
  if (isFinalRefund) return remainingFee;

  const proportional = (fee * refund) / captured;
  return proportional > remainingFee ? remainingFee : proportional;
}
