import { describe, it, expect, beforeEach, vi } from "vitest";
import { PayoutService } from "../src/modules/payment/payout.service";
import { Payout } from "../src/modules/payment/payout.types";
import { BadRequestError, NotFoundError } from "../src/modules/common/errors";

describe("Payouts & Concurrency Control (M6)", () => {
  let currentBalance: bigint;
  let lockAcquired: boolean;
  const payoutsTable = new Map<string, Payout>();
  let ledgerPayoutCalls: any[] = [];

  const mockAccount = {
    id: "acc_merchant_payable_1",
    merchantId: "merchant-1",
    type: "LIABILITY" as const,
    name: "MERCHANT_PAYABLE",
    currency: "USD",
    balance: 0n,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPayoutRepo = {
    // Simulates PostgreSQL SELECT ... FOR UPDATE row-level lock
    lockMerchantAccountForUpdate: vi.fn(async () => {
      // Simulate mutex / serialization
      while (lockAcquired) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      lockAcquired = true;
      return mockAccount;
    }),

    createPayout: vi.fn(async (mId: string, amount: bigint, curr: string, dest: any) => {
      const id = `payout_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const p: Payout = {
        id,
        merchantId: mId,
        amount,
        currency: curr,
        status: "PENDING",
        destination: dest,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      payoutsTable.set(id, p);
      return p;
    }),

    updatePayoutStatus: vi.fn(async (id: string, expected: string, newStatus: any) => {
      const p = payoutsTable.get(id);
      if (p) p.status = newStatus;
      return p!;
    }),

    findByMerchantAndId: vi.fn(async (mId: string, id: string) => {
      const p = payoutsTable.get(id);
      if (!p || p.merchantId !== mId) return null;
      return p;
    }),

    listByMerchant: vi.fn(async (mId: string) => {
      return Array.from(payoutsTable.values()).filter((p) => p.merchantId === mId);
    }),
  } as any;

  const mockLedger = {
    recordMerchantPayout: vi.fn(async (mId: string, payoutId: string, amount: bigint, curr: string) => {
      ledgerPayoutCalls.push({ mId, payoutId, amount, curr });
      // Deduct balance in ledger
      currentBalance -= amount;
      return { transaction: { id: "tx_payout" }, entries: [], isRetry: false };
    }),
  } as any;

  const mockLedgerRepo = {
    getAccountBalance: vi.fn(async () => {
      return {
        accountId: mockAccount.id,
        accountName: mockAccount.name,
        accountType: mockAccount.type,
        currency: mockAccount.currency,
        balance: currentBalance,
      };
    }),
  } as any;

  const mockPool = {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          lockAcquired = false; // release simulated row lock on commit or rollback
        }
        return { rows: [] };
      }),
      release: vi.fn(() => {
        lockAcquired = false;
      }),
    })),
  } as any;

  let service: PayoutService;

  beforeEach(() => {
    currentBalance = 10000n; // $100.00
    lockAcquired = false;
    payoutsTable.clear();
    ledgerPayoutCalls = [];

    service = new PayoutService(mockPayoutRepo, mockLedger, mockLedgerRepo, mockPool);
  });

  describe("Balance Verification & Single Payout", () => {
    it("should process valid payout and deduct from ledger balance", async () => {
      const payout = await service.createPayout("merchant-1", {
        amount: "4000", // $40.00
        currency: "USD",
        destination: {
          type: "BANK_ACCOUNT",
          account_number: "US1234567890",
        },
      });

      expect(payout.status).toBe("COMPLETED");
      expect(payout.amount).toBe("4000");
      expect(currentBalance).toBe(6000n); // 10000 - 4000
      expect(ledgerPayoutCalls).toHaveLength(1);
      expect(ledgerPayoutCalls[0].amount).toBe(4000n);
    });

    it("should reject payout when requested amount exceeds available balance", async () => {
      currentBalance = 3000n; // Only $30 available

      await expect(
        service.createPayout("merchant-1", {
          amount: "5000", // Attempt to withdraw $50
          currency: "USD",
          destination: {
            type: "BANK_ACCOUNT",
            account_number: "US1234567890",
          },
        })
      ).rejects.toThrowError(BadRequestError);

      expect(currentBalance).toBe(3000n); // Untouched
      expect(ledgerPayoutCalls).toHaveLength(0);
    });
  });

  describe("Simultaneous Concurrent Payouts (Race Condition Prevention via SELECT FOR UPDATE)", () => {
    it("should prevent double-spending when two concurrent payouts race for balance", async () => {
      // Merchant has $100 (10000 cents).
      // Two concurrent requests arrive at the exact same time, each requesting $70 (7000 cents).
      // Sum = $140 > $100!
      // In an unsafe system, both threads check 10000 >= 7000, both approve, resulting in -$40 balance.
      // With SELECT FOR UPDATE: One MUST succeed, and the other MUST fail with Insufficient Balance!

      const request1 = service.createPayout("merchant-1", {
        amount: "7000",
        currency: "USD",
        destination: { type: "BANK_ACCOUNT", account_number: "ACC_1" },
      });

      const request2 = service.createPayout("merchant-1", {
        amount: "7000",
        currency: "USD",
        destination: { type: "BANK_ACCOUNT", account_number: "ACC_2" },
      });

      const results = await Promise.allSettled([request1, request2]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Remaining balance must be exactly 3000 cents ($30), never negative!
      expect(currentBalance).toBe(3000n);
      expect(ledgerPayoutCalls).toHaveLength(1);
      expect(ledgerPayoutCalls[0].amount).toBe(7000n);

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedError).toBeInstanceOf(BadRequestError);
      expect(rejectedError.message).toContain("Insufficient available balance for payout");
    });
  });

  describe("Tenant Isolation Enforcement", () => {
    it("should return 404 when querying another merchant's payout", async () => {
      const payout = await service.createPayout("merchant-1", {
        amount: "1000",
        currency: "USD",
        destination: { type: "BANK_ACCOUNT", account_number: "ACC_1" },
      });

      // Merchant 2 queries Merchant 1's payout -> must throw 404 Not Found!
      await expect(
        service.getPayoutById("merchant-2-attacker", payout.id)
      ).rejects.toThrowError(NotFoundError);
    });
  });
});
