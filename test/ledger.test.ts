import { describe, it, expect, vi } from "vitest";
import { calculateCaptureFee, calculateRefundReversal } from "../src/modules/ledger/ledger.fee";
import { LedgerService } from "../src/modules/ledger/ledger.service";
import { UnprocessableEntityError } from "../src/modules/common/errors";
import { PostEntryInput } from "../src/modules/ledger/ledger.types";

describe("Ledger Engine - Double Entry Core & Fees (M2)", () => {
  describe("Fee Calculation (Flat 2%, floor rounding, integer math)", () => {
    it("should calculate exact 2% fee on round amounts", () => {
      // $10.00 = 1000 cents
      const result = calculateCaptureFee(1000n);
      expect(result.grossAmount).toBe(1000n);
      expect(result.feeAmount).toBe(20n);
      expect(result.netAmount).toBe(980n);
      expect(result.feeAmount + result.netAmount).toBe(result.grossAmount);
    });

    it("should floor round fractional cents correctly", () => {
      // $10.55 = 1055 cents. 2% = 21.10 cents -> floor to 21 cents
      const result = calculateCaptureFee(1055n);
      expect(result.feeAmount).toBe(21n);
      expect(result.netAmount).toBe(1034n);
      expect(result.feeAmount + result.netAmount).toBe(result.grossAmount);
    });

    it("should handle small amounts with floor rounding to 0", () => {
      // $0.49 = 49 cents. 2% = 0.98 cents -> floor to 0
      const result = calculateCaptureFee(49n);
      expect(result.feeAmount).toBe(0n);
      expect(result.netAmount).toBe(49n);
      expect(result.feeAmount + result.netAmount).toBe(result.grossAmount);
    });

    it("should calculate proportional refund fee reversal", () => {
      // Partial refund of 500 cents on a 1000 cents capture
      const result = calculateRefundReversal(500n);
      expect(result.refundAmount).toBe(500n);
      expect(result.feeReversal).toBe(10n); // 2% of 500 = 10
      expect(result.netDebitFromMerchant).toBe(490n);
      expect(result.feeReversal + result.netDebitFromMerchant).toBe(result.refundAmount);
    });
  });

  describe("Double-Entry Balance Validation", () => {
    const service = new LedgerService({} as any, {} as any);

    it("should pass validation when Debits equal Credits", () => {
      const balancedEntries: PostEntryInput[] = [
        { accountId: "acc-1", direction: "DEBIT", amount: 1000n, currency: "USD" },
        { accountId: "acc-2", direction: "CREDIT", amount: 980n, currency: "USD" },
        { accountId: "acc-3", direction: "CREDIT", amount: 20n, currency: "USD" },
      ];

      expect(() => service.validateDoubleEntryBalance(balancedEntries)).not.toThrow();
    });

    it("should reject unbalanced entries with UnprocessableEntityError", () => {
      const unbalancedEntries: PostEntryInput[] = [
        { accountId: "acc-1", direction: "DEBIT", amount: 1000n, currency: "USD" },
        { accountId: "acc-2", direction: "CREDIT", amount: 950n, currency: "USD" }, // 50 cents missing!
      ];

      expect(() => service.validateDoubleEntryBalance(unbalancedEntries)).toThrowError(
        UnprocessableEntityError
      );
    });

    it("should reject non-positive amounts (amount <= 0)", () => {
      const invalidEntries: PostEntryInput[] = [
        { accountId: "acc-1", direction: "DEBIT", amount: 0n, currency: "USD" },
        { accountId: "acc-2", direction: "CREDIT", amount: 0n, currency: "USD" },
      ];

      expect(() => service.validateDoubleEntryBalance(invalidEntries)).toThrowError(
        UnprocessableEntityError
      );
    });

    it("should validate balance per currency in multi-currency transactions", () => {
      const mixedEntries: PostEntryInput[] = [
        // USD balanced
        { accountId: "acc-1", direction: "DEBIT", amount: 100n, currency: "USD" },
        { accountId: "acc-2", direction: "CREDIT", amount: 100n, currency: "USD" },
        // EUR unbalanced
        { accountId: "acc-3", direction: "DEBIT", amount: 200n, currency: "EUR" },
        { accountId: "acc-4", direction: "CREDIT", amount: 190n, currency: "EUR" },
      ];

      expect(() => service.validateDoubleEntryBalance(mixedEntries)).toThrowError(
        /Unbalanced ledger transaction for currency EUR/
      );
    });
  });

  describe("Capture, Refund, and Payout Double-Entry Accounting", () => {
    const mockAccounts: Record<string, any> = {
      PSP_CLEARING: { id: "acc-psp", type: "ASSET", name: "PSP_CLEARING", currency: "USD", balance: 0n },
      FEE_REVENUE: { id: "acc-fee", type: "REVENUE", name: "FEE_REVENUE", currency: "USD", balance: 0n },
      MERCHANT_PAYABLE: { id: "acc-merch", type: "LIABILITY", name: "MERCHANT_PAYABLE", currency: "USD", balance: 0n },
    };

    let postedEntries: PostEntryInput[] = [];
    let postedTx: any = null;

    const mockRepo = {
      findSystemAccount: vi.fn(async (name: string) => mockAccounts[name] || null),
      findMerchantAccount: vi.fn(async () => mockAccounts.MERCHANT_PAYABLE),
      createTransaction: vi.fn(async (input: any) => {
        postedTx = { id: "tx-100", ...input };
        return { transaction: postedTx, isNew: true };
      }),
      createEntries: vi.fn(async (txId: string, entries: PostEntryInput[]) => {
        postedEntries = entries;
        return entries.map((e, idx) => ({ id: `entry-${idx}`, transactionId: txId, ...e, createdAt: new Date() }));
      }),
      getTransactionWithEntries: vi.fn(async () => ({ transaction: postedTx, entries: postedEntries })),
      getAccountBalance: vi.fn(async () => ({
        accountId: "acc-merch",
        accountName: "MERCHANT_PAYABLE",
        accountType: "LIABILITY",
        currency: "USD",
        balance: 980n,
      })),
    } as any;

    const mockPool = {
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
    } as any;

    const service = new LedgerService(mockRepo, mockPool);

    it("should generate perfectly balanced entries on payment capture", async () => {
      const grossAmount = 5000n; // $50.00
      const result = await service.recordPaymentCapture("m-1", "pay-1", grossAmount, "USD");

      expect(result.isRetry).toBe(false);
      expect(postedEntries).toHaveLength(3);

      const pspEntry = postedEntries.find((e) => e.accountId === "acc-psp");
      const merchEntry = postedEntries.find((e) => e.accountId === "acc-merch");
      const feeEntry = postedEntries.find((e) => e.accountId === "acc-fee");

      expect(pspEntry).toMatchObject({ direction: "DEBIT", amount: 5000n });
      expect(merchEntry).toMatchObject({ direction: "CREDIT", amount: 4900n }); // 5000 - 100
      expect(feeEntry).toMatchObject({ direction: "CREDIT", amount: 100n }); // 2% of 5000 = 100

      // In double-entry: sum of DEBITS must equal sum of CREDITS
      const totalDebits = postedEntries
        .filter((e) => e.direction === "DEBIT")
        .reduce((sum, e) => sum + e.amount, 0n);
      const totalCredits = postedEntries
        .filter((e) => e.direction === "CREDIT")
        .reduce((sum, e) => sum + e.amount, 0n);

      expect(totalDebits).toBe(totalCredits);
    });

    it("should generate perfectly balanced entries on payment refund with fee reversal", async () => {
      const refundAmount = 2000n; // $20.00
      await service.recordPaymentRefund("m-1", "ref-1", refundAmount, "USD");

      expect(postedEntries).toHaveLength(3);

      const merchEntry = postedEntries.find((e) => e.accountId === "acc-merch");
      const feeEntry = postedEntries.find((e) => e.accountId === "acc-fee");
      const pspEntry = postedEntries.find((e) => e.accountId === "acc-psp");

      expect(merchEntry).toMatchObject({ direction: "DEBIT", amount: 1960n }); // 2000 - 40
      expect(feeEntry).toMatchObject({ direction: "DEBIT", amount: 40n }); // 2% of 2000 = 40
      expect(pspEntry).toMatchObject({ direction: "CREDIT", amount: 2000n });

      const totalDebits = postedEntries
        .filter((e) => e.direction === "DEBIT")
        .reduce((sum, e) => sum + e.amount, 0n);
      const totalCredits = postedEntries
        .filter((e) => e.direction === "CREDIT")
        .reduce((sum, e) => sum + e.amount, 0n);

      expect(totalDebits).toBe(totalCredits);
    });

    it("should generate balanced entries on merchant payout", async () => {
      const payoutAmount = 1500n;
      await service.recordMerchantPayout("m-1", "payout-1", payoutAmount, "USD");

      expect(postedEntries).toHaveLength(2);

      const merchEntry = postedEntries.find((e) => e.accountId === "acc-merch");
      const pspEntry = postedEntries.find((e) => e.accountId === "acc-psp");

      expect(merchEntry).toMatchObject({ direction: "DEBIT", amount: 1500n });
      expect(pspEntry).toMatchObject({ direction: "CREDIT", amount: 1500n });

      expect(merchEntry?.amount).toBe(pspEntry?.amount);
    });
  });
});
