import { ReconciliationMismatch, ReconciliationMismatchType, SettlementRow } from "./recon.types";

export interface PaymentSettlementSnapshot {
  paymentId: string;
  amount: string;
  currency: string;
  status: string;
}

export class ReconciliationService {
  parseSettlementCsv(csv: string): SettlementRow[] {
    const lines = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length <= 1) {
      return [];
    }

    const header = lines[0].split(",");
    const indexMap = new Map<string, number>();
    header.forEach((key, idx) => indexMap.set(key.trim(), idx));

    return lines.slice(1).map((line) => {
      const values = line.split(",");
      return {
        pspRef: values[indexMap.get("psp_ref") ?? 0]?.trim() ?? "",
        ourPaymentId: values[indexMap.get("our_payment_id") ?? 1]?.trim() ?? "",
        amount: values[indexMap.get("amount") ?? 2]?.trim() ?? "0",
        currency: values[indexMap.get("currency") ?? 3]?.trim() ?? "USD",
        status: values[indexMap.get("status") ?? 4]?.trim() ?? "UNKNOWN",
        settledAt: values[indexMap.get("settled_at") ?? 5]?.trim() ?? new Date().toISOString(),
      };
    });
  }

  compareSettlement(
    internalPayments: PaymentSettlementSnapshot[],
    settlementCsv: string
  ): ReconciliationMismatch[] {
    const rows = this.parseSettlementCsv(settlementCsv);
    const paymentMap = new Map(internalPayments.map((p) => [p.paymentId, p]));
    const pspMap = new Map(rows.map((row) => [row.ourPaymentId, row]));
    const mismatches: ReconciliationMismatch[] = [];

    for (const payment of internalPayments) {
      const row = pspMap.get(payment.paymentId);
      if (!row) {
        mismatches.push({
          type: "MISSING_PSP",
          ourPaymentId: payment.paymentId,
          message: `PSP settlement is missing for internal payment ${payment.paymentId}`,
        });
        continue;
      }

      if (row.amount !== payment.amount) {
        mismatches.push({
          type: "AMOUNT_DIFF",
          ourPaymentId: payment.paymentId,
          pspRef: row.pspRef,
          expectedAmount: payment.amount,
          actualAmount: row.amount,
          message: `Amount mismatch for payment ${payment.paymentId}`,
        });
      }

      if (row.status !== payment.status) {
        mismatches.push({
          type: "STATUS_DIFF",
          ourPaymentId: payment.paymentId,
          pspRef: row.pspRef,
          expectedStatus: payment.status,
          actualStatus: row.status,
          message: `Status mismatch for payment ${payment.paymentId}`,
        });
      }
    }

    for (const row of rows) {
      if (!paymentMap.has(row.ourPaymentId)) {
        mismatches.push({
          type: "MISSING_INTERNAL",
          pspRef: row.pspRef,
          ourPaymentId: row.ourPaymentId,
          expectedAmount: row.amount,
          message: `Internal payment missing for PSP record ${row.pspRef}`,
        });
      }
    }

    return mismatches;
  }
}

export const reconciliationService = new ReconciliationService();
