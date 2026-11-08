import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 5 forwards rejected promises to the error middleware on its own, but
 * we keep this wrapper so handler signature stays explicit and so it also works
 * if we ever pin Express 4. Every controller must be wrapped: an unhandled
 * rejection is how a payment service ends up returning 200 with no body.
 */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}
