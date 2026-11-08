import type { Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../common/async-handler";
import { requireAuth } from "../merchant/auth.middleware";
import type { LedgerService } from "./ledger.service";
import { LedgerQuerySchema } from "./ledger.types";

export class LedgerController {
  constructor(private readonly service: LedgerService) {}

  listAccounts = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const accounts = await this.service.listAccounts(auth.merchantId);
      res.status(200).json({ accounts });
    });

  getStatement = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const accountId = req.params["accountId"] as string;
      const query = LedgerQuerySchema.parse(req.query);
      const statement = await this.service.getStatement(accountId, auth.merchantId, query);
      res.status(200).json(statement);
    });
}
