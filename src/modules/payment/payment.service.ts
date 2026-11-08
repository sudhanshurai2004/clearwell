import { Pool } from "pg";
import { pool } from "../common/db";
import { NotFoundError, BadRequestError, ConflictError, GatewayTimeoutError } from "../common/errors";
import { PaymentRepository, paymentRepository } from "./payment.repository";
import { PaymentStateMachine } from "./payment.state-machine";
import { PspClient, defaultPspClient } from "./psp/psp.client";
import { LedgerService, ledgerService } from "../ledger/ledger.service";
import { CreatePaymentInput, PaymentResponseDto } from "./payment.dtos";
import { Payment } from "./payment.types";

export class PaymentService {
  constructor(
    private readonly paymentRepo: PaymentRepository = paymentRepository,
    private readonly pspClient: PspClient = defaultPspClient,
    private readonly ledger: LedgerService = ledgerService,
    private readonly dbPool: Pool = pool
  ) {}

  private mapToDto(p: Payment): PaymentResponseDto {
    return {
      id: p.id,
      merchant_id: p.merchantId,
      amount: p.amount.toString(),
      currency: p.currency,
      status: p.status,
      authorized_amount: p.authorizedAmount.toString(),
      captured_amount: p.capturedAmount.toString(),
      refunded_amount: p.refundedAmount.toString(),
      psp_ref: p.pspRef,
      created_at: p.createdAt.toISOString(),
      updated_at: p.updatedAt.toISOString(),
    };
  }

  /**
   * Phase 1: Pre-network DB commit -> Network call -> Phase 2: Post-network DB commit.
   * Never holds a database lock across a network call to the PSP!
   */
  async createAndAuthorize(
    merchantId: string,
    input: CreatePaymentInput
  ): Promise<PaymentResponseDto> {
    const amount = BigInt(input.amount);

    // ==========================================
    // TRANSACTION 1: Pre-network state commit
    // ==========================================
    let payment: Payment;
    const client1 = await this.dbPool.connect();
    try {
      await client1.query("BEGIN");

      // 1. Create payment in CREATED status
      payment = await this.paymentRepo.createPayment(merchantId, amount, input.currency, client1);
      await this.paymentRepo.recordEvent(
        payment.id,
        null,
        "CREATED",
        "PAYMENT_CREATED",
        { amount: input.amount, currency: input.currency },
        client1
      );

      // 2. Transition CREATED -> AUTH_PENDING
      PaymentStateMachine.assertValidPaymentTransition("CREATED", "AUTH_PENDING", payment.id);
      payment = await this.paymentRepo.updatePaymentState(
        payment.id,
        "CREATED",
        "AUTH_PENDING",
        {},
        client1
      );
      await this.paymentRepo.recordEvent(
        payment.id,
        "CREATED",
        "AUTH_PENDING",
        "AUTH_INITIATED",
        {},
        client1
      );

      await client1.query("COMMIT");
    } catch (err) {
      await client1.query("ROLLBACK");
      throw err;
    } finally {
      client1.release();
    }

    // ==========================================
    // NETWORK CALL: Outside any DB transaction!
    // ==========================================
    let pspOutcome: Awaited<ReturnType<PspClient["authorize"]>> | null = null;
    let isTimeout = false;

    try {
      pspOutcome = await this.pspClient.authorize({
        ourReference: payment.id,
        amount: input.amount,
        currency: input.currency,
        cardNumber: input.payment_method.card_number,
      });
    } catch (err) {
      if (err instanceof GatewayTimeoutError) {
        // Golden rule: Provider timeout = UNKNOWN, never DECLINED
        isTimeout = true;
      } else {
        throw err;
      }
    }

    // ==========================================
    // TRANSACTION 2: Post-network outcome commit
    // ==========================================
    const client2 = await this.dbPool.connect();
    try {
      await client2.query("BEGIN");

      if (isTimeout) {
        PaymentStateMachine.assertValidPaymentTransition("AUTH_PENDING", "UNKNOWN", payment.id);
        payment = await this.paymentRepo.updatePaymentState(
          payment.id,
          "AUTH_PENDING",
          "UNKNOWN",
          {},
          client2
        );
        await this.paymentRepo.recordEvent(
          payment.id,
          "AUTH_PENDING",
          "UNKNOWN",
          "AUTH_TIMEOUT",
          { error: "PSP network timeout" },
          client2
        );
      } else if (pspOutcome && pspOutcome.status === "AUTHORIZED") {
        PaymentStateMachine.assertValidPaymentTransition("AUTH_PENDING", "AUTHORIZED", payment.id);
        payment = await this.paymentRepo.updatePaymentState(
          payment.id,
          "AUTH_PENDING",
          "AUTHORIZED",
          {
            authorizedAmount: amount,
            pspRef: pspOutcome.pspReference,
          },
          client2
        );
        await this.paymentRepo.recordEvent(
          payment.id,
          "AUTH_PENDING",
          "AUTHORIZED",
          "AUTH_SUCCEEDED",
          {
            pspRef: pspOutcome.pspReference,
            authorizationCode: pspOutcome.authorizationCode,
          },
          client2
        );
        // Authorization writes NO ledger entries!
      } else {
        PaymentStateMachine.assertValidPaymentTransition("AUTH_PENDING", "DECLINED", payment.id);
        payment = await this.paymentRepo.updatePaymentState(
          payment.id,
          "AUTH_PENDING",
          "DECLINED",
          { pspRef: pspOutcome?.pspReference },
          client2
        );
        await this.paymentRepo.recordEvent(
          payment.id,
          "AUTH_PENDING",
          "DECLINED",
          "AUTH_DECLINED",
          {
            pspRef: pspOutcome?.pspReference,
            declineReason: pspOutcome?.declineReason,
          },
          client2
        );
      }

      await client2.query("COMMIT");
    } catch (err) {
      await client2.query("ROLLBACK");
      throw err;
    } finally {
      client2.release();
    }

    return this.mapToDto(payment);
  }

  /**
   * Captures an authorized payment and posts balanced entries to the double-entry ledger.
   */
  async capturePayment(
    merchantId: string,
    paymentId: string,
    requestedCaptureAmount?: bigint
  ): Promise<PaymentResponseDto> {
    let payment = await this.paymentRepo.findByMerchantAndId(merchantId, paymentId);
    if (!payment) {
      throw new NotFoundError("Payment not found");
    }

    if (payment.status !== "AUTHORIZED" && payment.status !== "CAPTURE_PENDING") {
      throw new ConflictError(`Cannot capture payment in status '${payment.status}'`);
    }

    const availableToCapture = payment.authorizedAmount - payment.capturedAmount;
    const captureAmount = requestedCaptureAmount ?? availableToCapture;

    if (captureAmount <= 0n) {
      throw new BadRequestError("Capture amount must be greater than zero");
    }

    if (captureAmount > availableToCapture) {
      throw new BadRequestError(
        `Requested capture amount ${captureAmount} exceeds available authorized amount ${availableToCapture}`
      );
    }

    if (!payment.pspRef) {
      throw new ConflictError("Cannot capture payment without valid PSP reference");
    }

    // ==========================================
    // TRANSACTION 1: Pre-network state commit: AUTHORIZED -> CAPTURE_PENDING
    // ==========================================
    if (payment.status === "AUTHORIZED") {
      const client1 = await this.dbPool.connect();
      try {
        await client1.query("BEGIN");
        PaymentStateMachine.assertValidPaymentTransition("AUTHORIZED", "CAPTURE_PENDING", payment.id);
        payment = await this.paymentRepo.updatePaymentState(
          payment.id,
          "AUTHORIZED",
          "CAPTURE_PENDING",
          {},
          client1
        );
        await this.paymentRepo.recordEvent(
          payment.id,
          "AUTHORIZED",
          "CAPTURE_PENDING",
          "CAPTURE_INITIATED",
          { captureAmount: captureAmount.toString() },
          client1
        );
        await client1.query("COMMIT");
      } catch (err) {
        await client1.query("ROLLBACK");
        throw err;
      } finally {
        client1.release();
      }
    }

    // ==========================================
    // NETWORK CALL: Outside any DB transaction
    // ==========================================
    try {
      await this.pspClient.capture({
        pspReference: payment.pspRef!,
        amount: captureAmount.toString(),
      });
    } catch (err) {
      // On capture failure or timeout: revert CAPTURE_PENDING -> AUTHORIZED (mentor gap-fix)
      const revertClient = await this.dbPool.connect();
      try {
        await revertClient.query("BEGIN");
        PaymentStateMachine.assertValidPaymentTransition("CAPTURE_PENDING", "AUTHORIZED", payment.id);
        await this.paymentRepo.updatePaymentState(
          payment.id,
          "CAPTURE_PENDING",
          "AUTHORIZED",
          {},
          revertClient
        );
        await this.paymentRepo.recordEvent(
          payment.id,
          "CAPTURE_PENDING",
          "AUTHORIZED",
          "CAPTURE_FAILED_REVERTED",
          { error: (err as Error).message },
          revertClient
        );
        await revertClient.query("COMMIT");
      } catch (revertErr) {
        await revertClient.query("ROLLBACK");
      } finally {
        revertClient.release();
      }
      throw err;
    }

    // ==========================================
    // TRANSACTION 2: Post-network outcome commit: CAPTURE_PENDING -> CAPTURED + Ledger
    // ==========================================
    const client2 = await this.dbPool.connect();
    let updatedPayment: Payment;
    try {
      await client2.query("BEGIN");

      const newCapturedAmount = payment.capturedAmount + captureAmount;

      PaymentStateMachine.assertValidPaymentTransition("CAPTURE_PENDING", "CAPTURED", payment.id);

      updatedPayment = await this.paymentRepo.updatePaymentState(
        payment.id,
        "CAPTURE_PENDING",
        "CAPTURED",
        { capturedAmount: newCapturedAmount },
        client2
      );

      await this.paymentRepo.recordEvent(
        payment.id,
        "CAPTURE_PENDING",
        "CAPTURED",
        "CAPTURE_SUCCEEDED",
        { captureAmount: captureAmount.toString() },
        client2
      );

      // Post to Double-Entry Ledger:
      // Debit: PSP_CLEARING (gross), Credit: MERCHANT_PAYABLE (net), Credit: FEE_REVENUE (fee)
      await this.ledger.recordPaymentCapture(
        merchantId,
        payment.id,
        captureAmount,
        payment.currency
      );

      await client2.query("COMMIT");
    } catch (err) {
      await client2.query("ROLLBACK");
      throw err;
    } finally {
      client2.release();
    }

    return this.mapToDto(updatedPayment);
  }

  /**
   * Voids an authorized payment before capture. Writes NO ledger entries.
   */
  async voidPayment(merchantId: string, paymentId: string): Promise<PaymentResponseDto> {
    const payment = await this.paymentRepo.findByMerchantAndId(merchantId, paymentId);
    if (!payment) {
      throw new NotFoundError("Payment not found");
    }

    if (payment.status !== "AUTHORIZED") {
      throw new ConflictError(`Cannot void payment in status '${payment.status}'`);
    }

    if (payment.capturedAmount > 0n) {
      throw new ConflictError("Cannot void payment that already has captured funds. Use refund instead.");
    }

    if (!payment.pspRef) {
      throw new ConflictError("Cannot void payment without valid PSP reference");
    }

    // Call PSP void over network
    await this.pspClient.void({ pspReference: payment.pspRef });

    const client = await this.dbPool.connect();
    let updatedPayment: Payment;
    try {
      await client.query("BEGIN");

      PaymentStateMachine.assertValidPaymentTransition("AUTHORIZED", "VOIDED", payment.id);

      updatedPayment = await this.paymentRepo.updatePaymentState(
        payment.id,
        "AUTHORIZED",
        "VOIDED",
        {},
        client
      );

      await this.paymentRepo.recordEvent(
        payment.id,
        "AUTHORIZED",
        "VOIDED",
        "PAYMENT_VOIDED",
        {},
        client
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return this.mapToDto(updatedPayment);
  }

  /**
   * Refunds a captured payment (full or partial) and posts proportional fee reversal to ledger.
   */
  async refundPayment(
    merchantId: string,
    paymentId: string,
    refundAmount: bigint,
    reason?: string
  ): Promise<PaymentResponseDto> {
    const payment = await this.paymentRepo.findByMerchantAndId(merchantId, paymentId);
    if (!payment) {
      throw new NotFoundError("Payment not found");
    }

    if (payment.status !== "CAPTURED" && payment.status !== "PARTIALLY_REFUNDED") {
      throw new ConflictError(`Cannot refund payment in status '${payment.status}'`);
    }

    const availableToRefund = payment.capturedAmount - payment.refundedAmount;
    if (refundAmount <= 0n) {
      throw new BadRequestError("Refund amount must be greater than zero");
    }

    if (refundAmount > availableToRefund) {
      throw new BadRequestError(
        `Requested refund ${refundAmount} exceeds available refundable amount ${availableToRefund}`
      );
    }

    if (!payment.pspRef) {
      throw new ConflictError("Cannot refund payment without valid PSP reference");
    }

    // Call PSP refund over network
    const pspRefundRes = await this.pspClient.refund({
      pspReference: payment.pspRef,
      amount: refundAmount.toString(),
    });

    const client = await this.dbPool.connect();
    let updatedPayment: Payment;
    try {
      await client.query("BEGIN");

      const newRefundedAmount = payment.refundedAmount + refundAmount;
      const targetStatus =
        newRefundedAmount === payment.capturedAmount ? "REFUNDED" : "PARTIALLY_REFUNDED";

      PaymentStateMachine.assertValidPaymentTransition(payment.status, targetStatus, payment.id);

      updatedPayment = await this.paymentRepo.updatePaymentState(
        payment.id,
        payment.status,
        targetStatus,
        { refundedAmount: newRefundedAmount },
        client
      );

      await this.paymentRepo.recordEvent(
        payment.id,
        payment.status,
        targetStatus,
        "REFUND_SUCCEEDED",
        {
          refundAmount: refundAmount.toString(),
          refundReference: pspRefundRes.refundReference,
          reason,
        },
        client
      );

      // Post proportional fee reversal to Double-Entry Ledger
      const refundRefId = `${payment.id}-ref-${newRefundedAmount}`;
      await this.ledger.recordPaymentRefund(
        merchantId,
        refundRefId,
        refundAmount,
        payment.currency
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return this.mapToDto(updatedPayment);
  }

  async getPaymentById(merchantId: string, paymentId: string): Promise<PaymentResponseDto> {
    const payment = await this.paymentRepo.findByMerchantAndId(merchantId, paymentId);
    if (!payment) {
      // Tenant Isolation: other tenant's payment = 404
      throw new NotFoundError("Payment not found");
    }
    return this.mapToDto(payment);
  }
}

export const paymentService = new PaymentService();
