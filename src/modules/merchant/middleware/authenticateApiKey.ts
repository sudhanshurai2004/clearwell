import { Request, Response, NextFunction } from "express";
import { UnauthorizedError, ForbiddenError } from "../../common/errors";
import { Merchant } from "../merchant.types";
import { merchantRepository, MerchantRepository } from "../merchant.repository";
import { verifyApiKey } from "../merchant.crypto";

declare global {
  namespace Express {
    interface Request {
      merchant: Merchant;
      scopes: string[];
    }
  }
}

export function createAuthMiddleware(repo: MerchantRepository = merchantRepository) {
  return async function authenticateApiKey(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new UnauthorizedError("Missing or malformed Authorization header. Expected 'Bearer cw_live_...'");
      }

      const apiKey = authHeader.substring(7).trim();
      if (!apiKey.startsWith("cw_live_") || apiKey.length < 20) {
        throw new UnauthorizedError("Invalid API key format");
      }

      const prefix = apiKey.substring(0, 16);
      const record = await repo.findActiveApiKeyByPrefix(prefix);

      if (!record) {
        throw new UnauthorizedError("Invalid or revoked API key");
      }

      const isValid = verifyApiKey(apiKey, record.apiKey.keyHash);
      if (!isValid) {
        throw new UnauthorizedError("Invalid API key");
      }

      req.merchant = record.merchant;
      req.scopes = record.apiKey.scopes;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const authenticateApiKey = createAuthMiddleware();

export function requireScope(requiredScope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.scopes || !req.scopes.includes(requiredScope)) {
      throw new ForbiddenError(`Insufficient scope. Required: '${requiredScope}'`);
    }
    next();
  };
}
