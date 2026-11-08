import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { AppError } from "../common/errors";
import { asyncHandler } from "../common/async-handler";
import type { Logger } from "../common/logger";
import { extractKeyPrefix, hashApiKey, safeCompareDigest } from "./api-key";
import type { Scope } from "./merchant.dto";
import { MerchantRepository } from "./merchant.repository";

export type AuthDeps = {
  readonly pool: Pool;
  readonly logger: Logger;
  readonly apiKeyHashSecret: string;
};

/**
 * Bearer API-key authentication.
 *
 * Order of checks matters for security and for information leakage:
 *   1. Header shape          -> 401 (no hint about which part failed)
 *   2. Key format + prefix   -> 401
 *   3. Row lookup by prefix  -> 401
 *   4. Constant-time hash compare -> 401
 *   5. revoked_at            -> 401
 *   6. merchant status       -> 403 (key is valid, merchant is suspended)
 *
 * The merchant id comes ONLY from the key. A client can never pass a merchant
 * id in the body/query and act on another tenant -- that is why every later
 * repository query is written as `WHERE merchant_id = $1` with this value.
 */
export function apiKeyAuth(deps: AuthDeps): RequestHandler {
  const repo = new MerchantRepository(deps.pool);

  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      throw AppError.unauthenticated("Authorization header must be: Bearer <api_key>");
    }

    const rawKey = header.slice("Bearer ".length).trim();
    const prefix = extractKeyPrefix(rawKey);
    if (!prefix) {
      throw AppError.unauthenticated("Malformed API key");
    }

    const row = await repo.findApiKeyByPrefix(prefix);
    if (!row) {
      throw AppError.unauthenticated("Invalid API key");
    }

    const presentedHash = hashApiKey(rawKey, deps.apiKeyHashSecret);
    if (!safeCompareDigest(presentedHash, row.key_hash)) {
      // Same message as "not found" on purpose: do not tell an attacker that
      // the prefix exists but the secret is wrong.
      throw AppError.unauthenticated("Invalid API key");
    }

    if (row.revoked_at !== null) {
      throw AppError.unauthenticated("API key has been revoked");
    }

    if (row.merchant_status !== "ACTIVE") {
      throw AppError.forbidden("Merchant account is not active");
    }

    req.auth = {
      merchantId: row.merchant_id,
      apiKeyId: row.id,
      scopes: row.scopes,
    };

    // Fire-and-forget: usage timestamp is nice-to-have, never a reason to fail
    // a request. Errors are swallowed deliberately.
    void repo.touchApiKeyLastUsed(row.id).catch((err: unknown) => {
      deps.logger.warn({ err, apiKeyId: row.id }, "api_key_touch_failed");
    });

    next();
  });
}

/**
 * Scope guard, used as `requireScope("payments:write")`.
 * Scope checks are about permissions; tenant checks are about ownership.
 * Cross-tenant reads return 404 (see AppError.notFound), insufficient scope is 403.
 */
export function requireScope(required: Scope): RequestHandler {
  return (req, _res, next) => {
    const scopes = req.auth?.scopes ?? [];
    if (!scopes.includes(required)) {
      next(AppError.forbidden(`This endpoint requires scope "${required}"`));
      return;
    }
    next();
  };
}

/** Narrow helper for handlers: auth is guaranteed by apiKeyAuth. */
export function requireAuth(req: Request): { merchantId: string; apiKeyId: string; scopes: readonly string[] } {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth;
}
