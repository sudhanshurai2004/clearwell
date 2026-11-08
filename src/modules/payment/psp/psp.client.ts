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
} from "./psp.types";
import { PspSimulator, pspSimulator } from "./psp-simulator";

/**
 * Universal Payment Service Provider (PSP) Adapter Interface.
 * Shields the payment core from provider-specific APIs (Stripe, PayPal, Simulator).
 */
export interface PspClient {
  authorize(req: PspAuthorizeRequest): Promise<PspAuthorizeResponse>;
  capture(req: PspCaptureRequest): Promise<PspCaptureResponse>;
  void(req: PspVoidRequest): Promise<PspVoidResponse>;
  refund(req: PspRefundRequest): Promise<PspRefundResponse>;
  statusInquiry(ourReference: string): Promise<PspStatusInquiryResponse | null>;
}

export class SimulatorPspClient implements PspClient {
  constructor(private readonly simulator: PspSimulator = pspSimulator) {}

  async authorize(req: PspAuthorizeRequest): Promise<PspAuthorizeResponse> {
    return this.simulator.authorize(req);
  }

  async capture(req: PspCaptureRequest): Promise<PspCaptureResponse> {
    return this.simulator.capture(req);
  }

  async void(req: PspVoidRequest): Promise<PspVoidResponse> {
    return this.simulator.void(req);
  }

  async refund(req: PspRefundRequest): Promise<PspRefundResponse> {
    return this.simulator.refund(req);
  }

  async statusInquiry(ourReference: string): Promise<PspStatusInquiryResponse | null> {
    return this.simulator.statusInquiry(ourReference);
  }
}

export const defaultPspClient: PspClient = new SimulatorPspClient();
