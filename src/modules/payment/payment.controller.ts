import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../common/async-handler";
import { requireAuth, requireScope } from "../merchant/auth.middleware";
import { CaptureSchema, CreatePaymentSchema, RefundSchema, VoidSchema } from "./payment.dto";
import type { PaymentService } from "./payment.service";

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Thin by design: parse -> service -> serialise. Any business rule you see here
 * would be in the wrong place.
 */
export class PaymentController {
  constructor(private readonly service: PaymentService) {}

  create = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const dto = CreatePaymentSchema.parse(req.body);
      const payment = await this.service.createPayment(auth.merchantId, dto, {
        correlationId: req.correlationId,
        ...(req.header("idempotency-key") ? { idempotencyKey: req.header("idempotency-key") as string } : {}),
      });
      // A provider timeout is NOT a failure to create the payment: we accepted
      // it, we simply do not know yet whether the charge happened.
      //   202 Accepted + state PENDING_CONFIRMATION
      // The client must poll /v1/payments/:id (or wait for the webhook) instead
      // of retrying, because retrying could create a second charge.
      if (payment.status === "UNKNOWN") {
        res.status(202).json({
          ...payment,
          state: "PENDING_CONFIRMATION",
          message:
            "The provider did not confirm in time. This payment is NOT declined; " +
            "its outcome will be resolved by status inquiry. Do not resubmit.",
        });
        return;
      }
      res.status(201).json(payment);
    });

  get = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const payment = await this.service.getPayment(auth.merchantId, req.params["paymentId"] as string);
      res.status(200).json(payment);
    });

  list = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const { limit } = ListQuerySchema.parse(req.query);
      const payments = await this.service.listPayments(auth.merchantId, limit);
      res.status(200).json({ payments });
    });

  events = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const events = await this.service.getEvents(auth.merchantId, req.params["paymentId"] as string);
      res.status(200).json({ events });
    });

  capture = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const dto = CaptureSchema.parse(req.body ?? {});
      const payment = await this.service.capture(auth.merchantId, req.params["paymentId"] as string, dto, {
        correlationId: req.correlationId,
      });
      res.status(200).json(payment);
    });

  void = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const dto = VoidSchema.parse(req.body ?? {});
      const payment = await this.service.voidPayment(auth.merchantId, req.params["paymentId"] as string, dto, {
        correlationId: req.correlationId,
      });
      res.status(200).json(payment);
    });

  refund = (): RequestHandler =>
    asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const dto = RefundSchema.parse(req.body ?? {});
      const payment = await this.service.refund(auth.merchantId, req.params["paymentId"] as string, dto, {
        correlationId: req.correlationId,
      });
      res.status(200).json(payment);
    });
}

export const paymentScopes = {
  write: requireScope("payments:write"),
  read: requireScope("payments:read"),
  refund: requireScope("refunds:write"),
};
