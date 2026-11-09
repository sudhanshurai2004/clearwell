import { RiskAssessment, RiskCheckInput } from "./risk.types";

const DEFAULT_MAX_AMOUNT_BY_CURRENCY: Record<string, bigint> = {
  USD: 1000000n,
  EUR: 1000000n,
  INR: 100000000n,
};

export class RiskService {
  constructor(
    private readonly maxAmountByCurrency: Record<string, bigint> = DEFAULT_MAX_AMOUNT_BY_CURRENCY,
    private readonly defaultVelocityLimit = 5
  ) {}

  evaluate(input: RiskCheckInput): RiskAssessment {
    if (!input.merchantId || !input.paymentId || input.amount <= 0n) {
      return {
        allowed: false,
        code: "INVALID_REQUEST",
        reason: "Payment request is invalid for risk evaluation.",
      };
    }

    const currency = input.currency.toUpperCase();
    const maxAmount = input.maxAmount ?? this.maxAmountByCurrency[currency] ?? 1000000n;

    if (input.amount > maxAmount) {
      return {
        allowed: false,
        code: "AMOUNT_LIMIT_EXCEEDED",
        reason: `Amount ${input.amount.toString()} exceeds configured limit for ${currency}.`,
        maxAmount: maxAmount.toString(),
        currentAmount: input.amount.toString(),
      };
    }

    const velocityLimit = input.velocityLimit ?? this.defaultVelocityLimit;
    const recentAuthorizationCount = input.recentAuthorizationCount ?? 0;

    if (recentAuthorizationCount >= velocityLimit) {
      return {
        allowed: false,
        code: "VELOCITY_LIMIT_EXCEEDED",
        reason: `Too many authorizations (${recentAuthorizationCount}) in the recent window.`,
      };
    }

    return {
      allowed: true,
      code: "ALLOWED",
    };
  }
}

export const riskService = new RiskService();
