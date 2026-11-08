import { Pool } from "pg";
import { pool } from "../common/db";
import { NotFoundError, BadRequestError } from "../common/errors";
import { PayoutRepository, payoutRepository } from "./payout.repository";
import { LedgerService, ledgerService } from "../ledger/ledger.service";
import { LedgerRepository, ledgerRepository } from "../ledger/ledger.repository";
import { PaymentStateMachine } from "./payment.state-machine";
import { CreatePayoutInput, PayoutResponseDto, Payout } from "./payout.types";

export class PayoutService {
  constructor(
    private readonly payoutRepo: PayoutRepository = payoutRepository,
    private readonly ledger: LedgerService = ledgerService,
    private readonly ledgerRepo: LedgerRepository = ledgerRepository,
    private readonly dbPool: Pool = pool
  ) {}

  private mapToDto(p: Payout): PayoutResponseDto {
    return {
      id: p.id,
      merchant_id: p.merchantId,
      amount: p.amount.toString(),
      currency: p.currency,
      status: p.status,
      destination: p.destination,
      created_at: p.createdAt.toISOString(),
      updated_at: p.updatedAt.toISOString(),
    };
  }

  /**
   * Processes a merchant payout against their available ledger balance.
   * Acquires a row-level lock (SELECT ... FOR UPDATE) on the merchant's account
   * to strictly prevent concurrent payout race conditions.
   */
  async createPayout(
    merchantId: string,
    input: CreatePayoutInput
  ): Promise<PayoutResponseDto> {
    const payoutAmount = BigInt(input.amount);
    const client = await this.dbPool.connect();

    try {
      await client.query("BEGIN");

      // 1. Acquire row lock on the merchant's payable account to serialize concurrent payouts
      const account = await this.payoutRepo.lockMerchantAccountForUpdate(
        client,
        merchantId,
        "MERCHANT_PAYABLE",
        input.currency
      );

      if (!account) {
        throw new NotFoundError(
          `MERCHANT_PAYABLE account not found for merchant '${merchantId}' and currency '${input.currency}'`
        );
      }

      // 2. Derive current ledger balance within the locked transaction
      const balanceInfo = await this.ledgerRepo.getAccountBalance(account.id, client);
      const availableBalance = balanceInfo ? balanceInfo.balance : 0n;

      if (availableBalance < payoutAmount) {
        throw new BadRequestError(
          `Insufficient available balance for payout. Available: ${availableBalance}, Requested: ${payoutAmount}`
        );
      }

      // 3. Create payout in PENDING status
      let payout = await this.payoutRepo.createPayout(
        merchantId,
        payoutAmount,
        input.currency,
        input.destination,
        client
      );

      // 4. Transition PENDING -> PROCESSING
      PaymentStateMachine.assertValidPayoutTransition("PENDING", "PROCESSING", payout.id);
      payout = await this.payoutRepo.updatePayoutStatus(
        payout.id,
        "PENDING",
        "PROCESSING",
        client
      );

      // 5. Post to double-entry ledger: Debit MERCHANT_PAYABLE, Credit PSP_CLEARING
      await this.ledger.recordMerchantPayout(
        merchantId,
        payout.id,
        payoutAmount,
        input.currency
      );

      // 6. Transition PROCESSING -> COMPLETED
      PaymentStateMachine.assertValidPayoutTransition("PROCESSING", "COMPLETED", payout.id);
      payout = await this.payoutRepo.updatePayoutStatus(
        payout.id,
        "PROCESSING",
        "COMPLETED",
        client
      );

      await client.query("COMMIT");
      return this.mapToDto(payout);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getPayoutById(merchantId: string, payoutId: string): Promise<PayoutResponseDto> {
    const payout = await this.payoutRepo.findByMerchantAndId(merchantId, payoutId);
    if (!payout) {
      // Tenant Isolation: other tenant's payout = 404
      throw new NotFoundError("Payout not found");
    }
    return this.mapToDto(payout);
  }

  async listPayouts(merchantId: string, limit = 50): Promise<PayoutResponseDto[]> {
    const list = await this.payoutRepo.listByMerchant(merchantId, limit);
    return list.map((p) => this.mapToDto(p));
  }
}

export const payoutService = new PayoutService();
