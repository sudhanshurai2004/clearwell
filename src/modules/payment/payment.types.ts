export type PaymentStatus =
  | "CREATED"
  | "RISK_REJECTED"
  | "AUTH_PENDING"
  | "AUTHORIZED"
  | "DECLINED"
  | "UNKNOWN"
  | "CAPTURE_PENDING"
  | "CAPTURED"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "VOIDED";

export type PayoutStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

export interface Payment {
  id: string;
  merchantId: string;
  amount: bigint;
  currency: string;
  status: PaymentStatus;
  authorizedAmount: bigint;
  capturedAmount: bigint;
  refundedAmount: bigint;
  pspRef: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentEvent {
  id: string;
  paymentId: string;
  previousStatus: PaymentStatus | null;
  newStatus: PaymentStatus;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface PaymentMethodInput {
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
  cardholderName?: string;
}

export interface CreatePaymentDto {
  amount: bigint;
  currency: string;
  paymentMethod: PaymentMethodInput;
}
