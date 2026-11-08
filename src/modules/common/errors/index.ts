export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad Request", details?: unknown) {
    super(400, "BAD_REQUEST", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", details?: unknown) {
    super(401, "UNAUTHORIZED", message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", details?: unknown) {
    super(403, "FORBIDDEN", message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details?: unknown) {
    super(404, "NOT_FOUND", message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message = "Unprocessable Entity", details?: unknown) {
    super(422, "UNPROCESSABLE_ENTITY", message, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too Many Requests", details?: unknown) {
    super(429, "TOO_MANY_REQUESTS", message, details);
  }
}

export class BadGatewayError extends AppError {
  constructor(message = "Bad Gateway", details?: unknown) {
    super(502, "BAD_GATEWAY", message, details);
  }
}

export class GatewayTimeoutError extends AppError {
  constructor(message = "Gateway Timeout", details?: unknown) {
    super(504, "GATEWAY_TIMEOUT", message, details);
  }
}
