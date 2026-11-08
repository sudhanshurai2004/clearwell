import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors";

export interface ErrorResponseEnvelope {
  error: {
    code: string;
    message: string;
    correlation_id: string;
    details?: unknown;
  };
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // Express requires 4 arguments to recognize an error-handling middleware
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const correlationId = req.correlationId || "unknown";

  if (err instanceof AppError) {
    const payload: ErrorResponseEnvelope = {
      error: {
        code: err.code,
        message: err.message,
        correlation_id: correlationId,
        ...(err.details !== undefined && { details: err.details }),
      },
    };
    res.status(err.statusCode).json(payload);
    return;
  }

  if (err instanceof ZodError) {
    const payload: ErrorResponseEnvelope = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request payload",
        correlation_id: correlationId,
        details: err.flatten(),
      },
    };
    res.status(400).json(payload);
    return;
  }

  // Handle syntax errors from express.json() bad body parsing
  if (err instanceof SyntaxError && "status" in err && err.status === 400) {
    const payload: ErrorResponseEnvelope = {
      error: {
        code: "BAD_REQUEST",
        message: "Malformed JSON payload",
        correlation_id: correlationId,
      },
    };
    res.status(400).json(payload);
    return;
  }

  // Fallback for unhandled / internal server errors
  console.error(`[UnhandledError] [Correlation: ${correlationId}]`, err);

  const isProduction = process.env.NODE_ENV === "production";
  const errorMessage = isProduction ? "An unexpected error occurred" : (err as Error)?.message || "Internal Server Error";

  const payload: ErrorResponseEnvelope = {
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: errorMessage,
      correlation_id: correlationId,
    },
  };

  res.status(500).json(payload);
}
