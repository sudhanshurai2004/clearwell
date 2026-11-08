import { Request, Response, NextFunction } from "express";
import { MerchantService, merchantService } from "./merchant.service";
import { createMerchantSchema } from "./merchant.types";

export class MerchantController {
  constructor(private readonly service: MerchantService = merchantService) {}

  onboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto = createMerchantSchema.parse(req.body);
      const result = await this.service.onboard(dto);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getMerchantProfile(req.merchant.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await this.service.getMerchantById(req.merchant.id, id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}

export const merchantController = new MerchantController();
