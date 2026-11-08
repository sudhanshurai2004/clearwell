import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

// Extend Express Request interface to include correlationId
declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.headers["x-correlation-id"];
  const correlationId = typeof incomingId === "string" && incomingId.trim().length > 0 
    ? incomingId 
    : uuidv4();

  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  next();
}
