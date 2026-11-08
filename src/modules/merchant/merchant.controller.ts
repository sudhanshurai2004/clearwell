import type { Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../common/async-handler";
import { requireAuth } from "./auth.middleware";
import { CreateApiKeySchema, CreateMerchantSchema } from "./merchant.dto";
import type { MerchantService } from "./merchant.service";

/**
 * Controllers do exactly three things: read input, call the service, write
 * output. No SQL, no business rules, no state machines. Validation happens at
 * the edge with Zod (the Node equivalent of Bean Validation's @Valid).
 */
export class MerchantController {
  constructor(private readonly service: MerchantService) {}

  /** Bootstrap endpoint: creates a merchant and returns its first API key once. */
  createMerchant = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const dto = CreateMerchantSchema.parse(req.body);
      const result = await this.service.createMerchant(dto, {
        live: req.app.get("nodeEnv") === "production",
      });
      res.status(201).json(result);
    });

  /** GET /v1/merchants/me -- the tenant is taken from the API key, not the URL. */
  getMe = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const merchant = await this.service.getMerchant(auth.merchantId);
      res.status(200).json(merchant);
    });

  createApiKey = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const dto = CreateApiKeySchema.parse(req.body ?? {});
      const key = await this.service.createApiKey(auth.merchantId, dto, {
        live: req.app.get("nodeEnv") === "production",
      });
      res.status(201).json(key);
    });
}
