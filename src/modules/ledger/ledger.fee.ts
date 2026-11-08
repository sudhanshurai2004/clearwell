import { FeeCalculation } from "./ledger.types";

export const DEFAULT_FEE_BPS = 200; // 2.00% (200 basis points)

/**
 * Calculates platform processing fee for payment capture using integer math.
 * Locked requirement: flat 2%, floor rounding, NO floating point numbers.
 */
export function calculateCaptureFee(
  grossAmount: bigint,
  feeBps: number = DEFAULT_FEE_BPS
): FeeCalculation {
  if (grossAmount <= 0n) {
    throw new Error("Gross amount must be positive for fee calculation");
  }

  // Integer floor division with BigInt: (amount * bps) / 10000
  const feeAmount = (grossAmount * BigInt(feeBps)) / 10000n;
  const netAmount = grossAmount - feeAmount;

  return {
    grossAmount,
    feeAmount,
    netAmount,
    feeBasisPoints: feeBps,
  };
}

/**
 * Calculates proportional fee reversal for payment refunds.
 * When a payment is refunded, the platform proportionally returns fee revenue.
 */
export function calculateRefundReversal(
  refundAmount: bigint,
  feeBps: number = DEFAULT_FEE_BPS
): {
  refundAmount: bigint;
  feeReversal: bigint;
  netDebitFromMerchant: bigint;
} {
  if (refundAmount <= 0n) {
    throw new Error("Refund amount must be positive");
  }

  const feeReversal = (refundAmount * BigInt(feeBps)) / 10000n;
  const netDebitFromMerchant = refundAmount - feeReversal;

  return {
    refundAmount,
    feeReversal,
    netDebitFromMerchant,
  };
}
