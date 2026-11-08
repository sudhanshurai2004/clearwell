import { Request, Response, NextFunction } from "express";
import { PayoutService, payoutService } from "./payout.service";
import { createPayoutSchema } from "./payout.types";

export class PayoutController {
  constructor(private readonly service: PayoutService = payoutService) {}

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = createPayoutSchema.parse(req.body);
      const result = await this.service.createPayout(req.merchant.id, input);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await this.service.getPayoutById(req.merchant.id, id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.listPayouts(req.merchant.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}

export const payoutController = new PayoutController();
