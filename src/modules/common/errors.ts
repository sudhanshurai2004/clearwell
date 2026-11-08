/**
 * One and only one error envelope for the whole API:
 *   { "error": { "code": "...", "message": "...", "correlation_id": "...", "details": [...] } }
 *
 * Controllers never build error bodies by hand and never throw raw strings.
 * They throw an AppError (or let the error middleware map a Zod failure), and
 * the central handler renders it. That keeps error codes consistent across
 * every module and makes the set of possible failures greppable.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE_ENTITY"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "PROVIDER_ERROR"
  | "PROVIDER_TIMEOUT"
  | "INTERNAL_ERROR";

export type ErrorDetail = { field: string; message: string };

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: readonly ErrorDetail[];

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: readonly ErrorDetail[],
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static validation(details: readonly ErrorDetail[], message = "Request validation failed") {
    return new AppError(400, "VALIDATION_ERROR", message, details);
  }
  static unauthenticated(message = "Missing or invalid API credentials") {
    return new AppError(401, "UNAUTHENTICATED", message);
  }
  static forbidden(message = "Insufficient scope for this operation") {
    return new AppError(403, "FORBIDDEN", message);
  }
  /**
   * NOTE: for cross-tenant access we deliberately return 404, not 403 --
   * a 403 would confirm that the id exists but belongs to someone else.
   */
  static notFound(message = "Resource not found") {
    return new AppError(404, "NOT_FOUND", message);
  }
  static conflict(message: string) {
    return new AppError(409, "CONFLICT", message);
  }
  static unprocessable(message: string, code: ErrorCode = "UNPROCESSABLE_ENTITY") {
    return new AppError(422, code, message);
  }
  static internal(message = "An unexpected error occurred") {
    return new AppError(500, "INTERNAL_ERROR", message);
  }
}
