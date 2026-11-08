import { Router } from "express";
import { paymentController } from "./payment.controller";
import { authenticateApiKey } from "../merchant/middleware/authenticateApiKey";
import { idempotencyMiddleware } from "../common/middleware/idempotency";

export const paymentRouter = Router();

// All payment mutation and query endpoints require valid merchant Bearer API key
paymentRouter.use(authenticateApiKey);

paymentRouter.post("/", idempotencyMiddleware(), paymentController.create);
paymentRouter.get("/:id", paymentController.getById);
paymentRouter.post("/:id/capture", idempotencyMiddleware(), paymentController.capture);
paymentRouter.post("/:id/void", idempotencyMiddleware(), paymentController.voidPayment);
paymentRouter.post("/:id/refunds", idempotencyMiddleware(), paymentController.refund);
