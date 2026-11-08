import { v4 as uuidv4 } from "uuid";
import { GatewayTimeoutError, NotFoundError, BadRequestError } from "../../common/errors";
import {
  PspAuthorizeRequest,
  PspAuthorizeResponse,
  PspCaptureRequest,
  PspCaptureResponse,
  PspVoidRequest,
  PspVoidResponse,
  PspRefundRequest,
  PspRefundResponse,
  PspStatusInquiryResponse,
  PspSettlementRecord,
  TEST_CARDS,
} from "./psp.types";

export interface SimulatedPspRecord {
  pspReference: string;
  ourReference: string;
  amount: string;
  currency: string;
  status: "AUTHORIZED" | "DECLINED" | "CAPTURED" | "REFUNDED" | "VOIDED";
  authorizationCode?: string;
  declineReason?: string;
  settledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class PspSimulator {
  private recordsByPspRef = new Map<string, SimulatedPspRecord>();
  private recordsByOurRef = new Map<string, SimulatedPspRecord>();

  /**
   * Resets simulator state (primarily for test isolation)
   */
  clear(): void {
    this.recordsByPspRef.clear();
    this.recordsByOurRef.clear();
  }

  async authorize(req: PspAuthorizeRequest): Promise<PspAuthorizeResponse> {
    // 1. Idempotency check: if ourReference already exists, return existing outcome
    const existing = this.recordsByOurRef.get(req.ourReference);
    if (existing) {
      return {
        pspReference: existing.pspReference,
        ourReference: existing.ourReference,
        status: existing.status === "DECLINED" ? "DECLINED" : "AUTHORIZED",
        authorizationCode: existing.authorizationCode,
        declineReason: existing.declineReason,
      };
    }

    // 2. Fault mode evaluation
    if (req.cardNumber === TEST_CARDS.TIMEOUT || req.faultMode === "TIMEOUT") {
      // Simulate network socket drop / timeout
      throw new GatewayTimeoutError("PSP connection timeout while processing authorization");
    }

    const pspReference = `psp_sim_${uuidv4().replace(/-/g, "").substring(0, 16)}`;

    if (
      req.cardNumber === TEST_CARDS.DECLINE ||
      req.cardNumber === TEST_CARDS.INSUFFICIENT_FUNDS ||
      req.faultMode === "DECLINE"
    ) {
      const declineReason =
        req.cardNumber === TEST_CARDS.INSUFFICIENT_FUNDS
          ? "INSUFFICIENT_FUNDS"
          : "DO_NOT_HONOR";

      const record: SimulatedPspRecord = {
        pspReference,
        ourReference: req.ourReference,
        amount: req.amount,
        currency: req.currency,
        status: "DECLINED",
        declineReason,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      this.recordsByPspRef.set(pspReference, record);
      this.recordsByOurRef.set(req.ourReference, record);

      return {
        pspReference,
        ourReference: req.ourReference,
        status: "DECLINED",
        declineReason,
      };
    }

    // 3. Successful Authorization
    const authorizationCode = `AUTH_${uuidv4().substring(0, 8).toUpperCase()}`;
    const record: SimulatedPspRecord = {
      pspReference,
      ourReference: req.ourReference,
      amount: req.amount,
      currency: req.currency,
      status: "AUTHORIZED",
      authorizationCode,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.recordsByPspRef.set(pspReference, record);
    this.recordsByOurRef.set(req.ourReference, record);

    return {
      pspReference,
      ourReference: req.ourReference,
      status: "AUTHORIZED",
      authorizationCode,
    };
  }

  async capture(req: PspCaptureRequest): Promise<PspCaptureResponse> {
    const record = this.recordsByPspRef.get(req.pspReference);
    if (!record) {
      throw new NotFoundError(`PSP transaction '${req.pspReference}' not found`);
    }

    if (record.status !== "AUTHORIZED" && record.status !== "CAPTURED") {
      throw new BadRequestError(`Cannot capture payment in status '${record.status}'`);
    }

    record.status = "CAPTURED";
    record.settledAt = new Date();
    record.updatedAt = new Date();

    return {
      pspReference: record.pspReference,
      status: "CAPTURED",
      capturedAmount: req.amount,
    };
  }

  async void(req: PspVoidRequest): Promise<PspVoidResponse> {
    const record = this.recordsByPspRef.get(req.pspReference);
    if (!record) {
      throw new NotFoundError(`PSP transaction '${req.pspReference}' not found`);
    }

    if (record.status !== "AUTHORIZED") {
      throw new BadRequestError(`Cannot void transaction in status '${record.status}'`);
    }

    record.status = "VOIDED";
    record.updatedAt = new Date();

    return {
      pspReference: record.pspReference,
      status: "VOIDED",
    };
  }

  async refund(req: PspRefundRequest): Promise<PspRefundResponse> {
    const record = this.recordsByPspRef.get(req.pspReference);
    if (!record) {
      throw new NotFoundError(`PSP transaction '${req.pspReference}' not found`);
    }

    if (record.status !== "CAPTURED" && record.status !== "REFUNDED") {
      throw new BadRequestError(`Cannot refund transaction in status '${record.status}'`);
    }

    record.status = "REFUNDED";
    record.updatedAt = new Date();
    const refundReference = `ref_sim_${uuidv4().substring(0, 12)}`;

    return {
      pspReference: record.pspReference,
      refundReference,
      status: "REFUNDED",
      refundedAmount: req.amount,
    };
  }

  async statusInquiry(ourReference: string): Promise<PspStatusInquiryResponse | null> {
    const record = this.recordsByOurRef.get(ourReference);
    if (!record) {
      return null;
    }

    return {
      pspReference: record.pspReference,
      ourReference: record.ourReference,
      status: record.status,
      amount: record.amount,
      currency: record.currency,
    };
  }

  generateSettlementCsv(): string {
    const header = "psp_ref,our_payment_id,amount,currency,status,settled_at";
    const rows: string[] = [header];

    for (const record of this.recordsByPspRef.values()) {
      if (record.status === "CAPTURED" || record.status === "REFUNDED") {
        const settledAt = record.settledAt ? record.settledAt.toISOString() : new Date().toISOString();
        rows.push(`${record.pspReference},${record.ourReference},${record.amount},${record.currency},${record.status},${settledAt}`);
      }
    }

    return rows.join("\n");
  }
}

export const pspSimulator = new PspSimulator();
