import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "./errors";
import type { Logger } from "./logger";

/** 404 fallback for unmatched routes, in the same envelope as everything else. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`No route matched ${req.method} ${req.path}`));
}

/**
 * The single place errors become HTTP responses.
 *
 * Rules:
 *  - Known AppError      -> its own status/code/message.
 *  - ZodError            -> 400 VALIDATION_ERROR with per-field details.
 *  - Anything else       -> 500 INTERNAL_ERROR, generic message to the client,
 *                           full stack to the log (never leak internals).
 */
export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof ZodError) {
      const appError = AppError.validation(
        err.issues.map((issue) => ({
          field: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      );
      respond(res, req, appError);
      return;
    }

    if (err instanceof AppError) {
      respond(res, req, err);
      return;
    }

    logger.error(
      { err, correlation_id: req.correlationId, path: req.path, method: req.method },
      "unhandled_error",
    );
    respond(res, req, AppError.internal());
  };
}

function respond(res: Response, req: Request, appError: AppError): void {
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      correlation_id: req.correlationId ?? "unknown",
      ...(appError.details && appError.details.length > 0
        ? { details: appError.details }
        : {}),
    },
  });
}
