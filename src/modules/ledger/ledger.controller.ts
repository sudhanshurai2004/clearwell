import { Request, Response, NextFunction } from "express";
import { LedgerService, ledgerService } from "./ledger.service";

export class LedgerController {
  constructor(private readonly service: LedgerService = ledgerService) {}

  getMyBalance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const currency = typeof req.query.currency === "string" ? req.query.currency.toUpperCase() : "USD";
      const balance = await this.service.getMerchantBalance(req.merchant.id, currency);

      res.status(200).json({
        account_id: balance.accountId,
        account_name: balance.accountName,
        account_type: balance.accountType,
        currency: balance.currency,
        balance: balance.balance.toString(),
      });
    } catch (err) {
      next(err);
    }
  };

  getAccountBalance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const balance = await this.service.getAccountBalance(id);

      res.status(200).json({
        account_id: balance.accountId,
        account_name: balance.accountName,
        account_type: balance.accountType,
        currency: balance.currency,
        balance: balance.balance.toString(),
      });
    } catch (err) {
      next(err);
    }
  };
}

export const ledgerController = new LedgerController();
