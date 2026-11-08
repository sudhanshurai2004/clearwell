import type { NextFunction, Request, Response } from "express";
import { newId } from "./ids";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id for this request. Always present once this middleware ran. */
      correlationId: string;
      /** Populated by the API-key auth middleware (M1.3). */
      auth?: {
        merchantId: string;
        apiKeyId: string;
        scopes: readonly string[];
      };
    }
  }
}

export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Accept an inbound correlation id only if it looks sane; otherwise mint one.
 * The id is echoed back on the response and included in every log line and
 * every error envelope, so one incident can be traced across services.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header(CORRELATION_ID_HEADER);
  const valid = inbound !== undefined && /^[A-Za-z0-9._-]{8,128}$/.test(inbound);
  req.correlationId = valid ? inbound : newId();
  res.setHeader("X-Correlation-Id", req.correlationId);
  next();
}
