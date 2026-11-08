import { Pool } from "pg";
import { pool } from "../common/db";
import { UnprocessableEntityError, NotFoundError } from "../common/errors";
import { LedgerRepository, ledgerRepository } from "./ledger.repository";
import {
  PostTransactionInput,
  PostEntryInput,
  LedgerTransaction,
  LedgerEntry,
  AccountBalance,
} from "./ledger.types";
import { calculateCaptureFee, calculateRefundReversal } from "./ledger.fee";

export class LedgerService {
  constructor(
    private readonly repo: LedgerRepository = ledgerRepository,
    private readonly dbPool: Pool = pool
  ) {}

  /**
   * Enforces double-entry equation: Debits must equal Credits per currency.
   * Throws UnprocessableEntityError if any balance mismatch or non-positive amount is found.
   */
  validateDoubleEntryBalance(entries: PostEntryInput[]): void {
    if (!entries || entries.length === 0) {
      throw new UnprocessableEntityError("Ledger transaction must contain at least two entries");
    }

    const currencyTotals = new Map<string, { debits: bigint; credits: bigint }>();

    for (const entry of entries) {
      if (entry.amount <= 0n) {
        throw new UnprocessableEntityError(`Ledger entry amount must be strictly positive, got ${entry.amount}`);
      }

      const current = currencyTotals.get(entry.currency) || { debits: 0n, credits: 0n };
      if (entry.direction === "DEBIT") {
        current.debits += entry.amount;
      } else {
        current.credits += entry.amount;
      }
      currencyTotals.set(entry.currency, current);
    }

    for (const [currency, totals] of currencyTotals.entries()) {
      if (totals.debits !== totals.credits) {
        throw new UnprocessableEntityError(
          `Unbalanced ledger transaction for currency ${currency}. Debits: ${totals.debits}, Credits: ${totals.credits}`
        );
      }
    }
  }

  async postTransaction(input: PostTransactionInput): Promise<{
    transaction: LedgerTransaction;
    entries: LedgerEntry[];
    isRetry: boolean;
  }> {
    // 1. Application-level mathematical verification
    this.validateDoubleEntryBalance(input.entries);

    // 2. Database transaction execution
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");

      // Idempotent claim on (reference_id, reference_type)
      const { transaction, isNew } = await this.repo.createTransaction(input, client);

      if (!isNew) {
        // Idempotent retry: return existing transaction and entries
        await client.query("COMMIT");
        const existing = await this.repo.getTransactionWithEntries(transaction.id, client);
        return {
          transaction,
          entries: existing ? existing.entries : [],
          isRetry: true,
        };
      }

      // Insert all multi-legged balanced entries
      const entries = await this.repo.createEntries(transaction.id, input.entries, client);

      // COMMIT: Triggers PostgreSQL deferred constraint trigger checking debits == credits
      await client.query("COMMIT");

      return { transaction, entries, isRetry: false };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Posts double-entry entries for a captured payment.
   * Debit:  PSP_CLEARING    (gross)
   * Credit: MERCHANT_PAYABLE (net)
   * Credit: FEE_REVENUE      (fee)
   */
  async recordPaymentCapture(
    merchantId: string,
    paymentId: string,
    grossAmount: bigint,
    currency: string = "USD",
    feeBps?: number
  ): Promise<{ transaction: LedgerTransaction; entries: LedgerEntry[]; isRetry: boolean }> {
    const feeCalc = calculateCaptureFee(grossAmount, feeBps);

    const [pspClearing, feeRevenue, merchantPayable] = await Promise.all([
      this.repo.findSystemAccount("PSP_CLEARING", currency),
      this.repo.findSystemAccount("FEE_REVENUE", currency),
      this.repo.findMerchantAccount(merchantId, "MERCHANT_PAYABLE", currency),
    ]);

    if (!pspClearing) throw new NotFoundError(`System account PSP_CLEARING not found for currency ${currency}`);
    if (!feeRevenue) throw new NotFoundError(`System account FEE_REVENUE not found for currency ${currency}`);
    if (!merchantPayable) throw new NotFoundError(`Account MERCHANT_PAYABLE not found for merchant ${merchantId} and currency ${currency}`);

    const entries: PostEntryInput[] = [
      {
        accountId: pspClearing.id,
        direction: "DEBIT",
        amount: feeCalc.grossAmount,
        currency,
      },
      {
        accountId: merchantPayable.id,
        direction: "CREDIT",
        amount: feeCalc.netAmount,
        currency,
      },
      {
        accountId: feeRevenue.id,
        direction: "CREDIT",
        amount: feeCalc.feeAmount,
        currency,
      },
    ];

    return this.postTransaction({
      merchantId,
      referenceId: paymentId,
      referenceType: "PAYMENT_CAPTURE",
      description: `Payment capture for ${paymentId}. Gross: ${grossAmount}, Fee: ${feeCalc.feeAmount}, Net: ${feeCalc.netAmount}`,
      entries,
    });
  }

  /**
   * Posts double-entry entries for a payment refund (with proportional fee reversal).
   * Debit:  MERCHANT_PAYABLE (net refund from merchant)
   * Debit:  FEE_REVENUE      (proportional fee reversed)
   * Credit: PSP_CLEARING     (gross refunded to cardholder)
   */
  async recordPaymentRefund(
    merchantId: string,
    refundId: string,
    refundAmount: bigint,
    currency: string = "USD",
    feeBps?: number
  ): Promise<{ transaction: LedgerTransaction; entries: LedgerEntry[]; isRetry: boolean }> {
    const refundCalc = calculateRefundReversal(refundAmount, feeBps);

    const [pspClearing, feeRevenue, merchantPayable] = await Promise.all([
      this.repo.findSystemAccount("PSP_CLEARING", currency),
      this.repo.findSystemAccount("FEE_REVENUE", currency),
      this.repo.findMerchantAccount(merchantId, "MERCHANT_PAYABLE", currency),
    ]);

    if (!pspClearing) throw new NotFoundError(`System account PSP_CLEARING not found for currency ${currency}`);
    if (!feeRevenue) throw new NotFoundError(`System account FEE_REVENUE not found for currency ${currency}`);
    if (!merchantPayable) throw new NotFoundError(`Account MERCHANT_PAYABLE not found for merchant ${merchantId}`);

    const entries: PostEntryInput[] = [
      {
        accountId: merchantPayable.id,
        direction: "DEBIT",
        amount: refundCalc.netDebitFromMerchant,
        currency,
      },
      {
        accountId: feeRevenue.id,
        direction: "DEBIT",
        amount: refundCalc.feeReversal,
        currency,
      },
      {
        accountId: pspClearing.id,
        direction: "CREDIT",
        amount: refundCalc.refundAmount,
        currency,
      },
    ];

    return this.postTransaction({
      merchantId,
      referenceId: refundId,
      referenceType: "PAYMENT_REFUND",
      description: `Refund ${refundId}. Gross: ${refundAmount}, Fee reversal: ${refundCalc.feeReversal}, Net merchant debit: ${refundCalc.netDebitFromMerchant}`,
      entries,
    });
  }

  /**
   * Posts double-entry entries for a merchant payout.
   * Debit:  MERCHANT_PAYABLE (decreases merchant payable liability)
   * Credit: PSP_CLEARING     (settles cash from clearing account)
   */
  async recordMerchantPayout(
    merchantId: string,
    payoutId: string,
    amount: bigint,
    currency: string = "USD"
  ): Promise<{ transaction: LedgerTransaction; entries: LedgerEntry[]; isRetry: boolean }> {
    const [pspClearing, merchantPayable] = await Promise.all([
      this.repo.findSystemAccount("PSP_CLEARING", currency),
      this.repo.findMerchantAccount(merchantId, "MERCHANT_PAYABLE", currency),
    ]);

    if (!pspClearing) throw new NotFoundError(`System account PSP_CLEARING not found for currency ${currency}`);
    if (!merchantPayable) throw new NotFoundError(`Account MERCHANT_PAYABLE not found for merchant ${merchantId}`);

    const entries: PostEntryInput[] = [
      {
        accountId: merchantPayable.id,
        direction: "DEBIT",
        amount,
        currency,
      },
      {
        accountId: pspClearing.id,
        direction: "CREDIT",
        amount,
        currency,
      },
    ];

    return this.postTransaction({
      merchantId,
      referenceId: payoutId,
      referenceType: "MERCHANT_PAYOUT",
      description: `Merchant payout ${payoutId} for ${amount} ${currency}`,
      entries,
    });
  }

  async getAccountBalance(accountId: string): Promise<AccountBalance> {
    const bal = await this.repo.getAccountBalance(accountId);
    if (!bal) {
      throw new NotFoundError(`Account ${accountId} not found`);
    }
    return bal;
  }

  async getMerchantBalance(merchantId: string, currency: string = "USD"): Promise<AccountBalance> {
    const acc = await this.repo.findMerchantAccount(merchantId, "MERCHANT_PAYABLE", currency);
    if (!acc) {
      throw new NotFoundError(`MERCHANT_PAYABLE account not found for merchant ${merchantId}`);
    }
    return this.getAccountBalance(acc.id);
  }
}

export const ledgerService = new LedgerService();
