import { Router } from "express";
import { paymentController } from "./payment.controller";
import { authenticateApiKey } from "../merchant/middleware/authenticateApiKey";

export const paymentRouter = Router();

// All payment mutation and query endpoints require valid merchant Bearer API key
paymentRouter.use(authenticateApiKey);

paymentRouter.post("/", paymentController.create);
paymentRouter.get("/:id", paymentController.getById);
paymentRouter.post("/:id/capture", paymentController.capture);
paymentRouter.post("/:id/void", paymentController.voidPayment);
paymentRouter.post("/:id/refunds", paymentController.refund);
