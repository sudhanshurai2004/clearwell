export type PspFaultMode = "NONE" | "DECLINE" | "TIMEOUT" | "LATENCY";

export const TEST_CARDS = {
  SUCCESS: "4111111111111111",
  DECLINE: "4000000000000002",
  TIMEOUT: "4000000000000003",
  INSUFFICIENT_FUNDS: "4000000000000004",
} as const;

export interface PspAuthorizeRequest {
  ourReference: string;
  amount: string; // string representation of minor units (e.g. "1000")
  currency: string;
  cardNumber: string;
  faultMode?: PspFaultMode;
}

export interface PspAuthorizeResponse {
  pspReference: string;
  ourReference: string;
  status: "AUTHORIZED" | "DECLINED";
  authorizationCode?: string;
  declineReason?: string;
}

export interface PspCaptureRequest {
  pspReference: string;
  amount: string;
}

export interface PspCaptureResponse {
  pspReference: string;
  status: "CAPTURED";
  capturedAmount: string;
}

export interface PspVoidRequest {
  pspReference: string;
}

export interface PspVoidResponse {
  pspReference: string;
  status: "VOIDED";
}

export interface PspRefundRequest {
  pspReference: string;
  amount: string;
}

export interface PspRefundResponse {
  pspReference: string;
  refundReference: string;
  status: "REFUNDED";
  refundedAmount: string;
}

export interface PspStatusInquiryResponse {
  pspReference: string;
  ourReference: string;
  status: "AUTHORIZED" | "DECLINED" | "CAPTURED" | "REFUNDED" | "VOIDED";
  amount: string;
  currency: string;
}

export interface PspSettlementRecord {
  psp_ref: string;
  our_payment_id: string;
  amount: string;
  currency: string;
  status: string;
  settled_at: string;
}
