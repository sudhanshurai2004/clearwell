export type RiskDecisionCode =
  | "ALLOWED"
  | "AMOUNT_LIMIT_EXCEEDED"
  | "VELOCITY_LIMIT_EXCEEDED"
  | "INVALID_REQUEST";

export interface RiskAssessment {
  allowed: boolean;
  code: RiskDecisionCode;
  reason?: string;
  maxAmount?: string;
  currentAmount?: string;
}

export interface RiskCheckInput {
  merchantId: string;
  paymentId: string;
  amount: bigint;
  currency: string;
  recentAuthorizationCount?: number;
  maxAmount?: bigint;
  velocityLimit?: number;
}
