import { Request, Response, NextFunction } from "express";
import { PaymentService, paymentService } from "./payment.service";
import {
  createPaymentSchema,
  capturePaymentSchema,
  refundPaymentSchema,
} from "./payment.dtos";

export class PaymentController {
  constructor(private readonly service: PaymentService = paymentService) {}

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = createPaymentSchema.parse(req.body);
      const result = await this.service.createAndAuthorize(req.merchant.id, input);

      // Provider timeout returns 202 Accepted / PENDING_CONFIRMATION, not 201 or 400
      if (result.status === "UNKNOWN") {
        res.status(202).json({
          status: "PENDING_CONFIRMATION",
          message: "Payment authorization is pending confirmation due to provider timeout",
          payment: result,
        });
        return;
      }

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await this.service.getPaymentById(req.merchant.id, id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  capture = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const body = capturePaymentSchema.parse(req.body);
      const captureAmount = body.amount !== undefined ? BigInt(body.amount) : undefined;

      const result = await this.service.capturePayment(req.merchant.id, id, captureAmount);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  voidPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await this.service.voidPayment(req.merchant.id, id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  refund = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const body = refundPaymentSchema.parse(req.body);

      const result = await this.service.refundPayment(
        req.merchant.id,
        id,
        BigInt(body.amount),
        body.reason
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  recoverUnknownPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawLimit = Number(req.query.limit ?? 25);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 25;
      const result = await this.service.recoverUnknownPayments(limit);
      res.status(200).json({
        status: "OK",
        ...result,
      });
    } catch (err) {
      next(err);
    }
  };
}

export const paymentController = new PaymentController();
