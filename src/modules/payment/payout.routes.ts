import { Router } from "express";
import { payoutController } from "./payout.controller";
import { authenticateApiKey } from "../merchant/middleware/authenticateApiKey";
import { idempotencyMiddleware } from "../common/middleware/idempotency";

export const payoutRouter = Router();

// Payout endpoints require merchant authentication
payoutRouter.use(authenticateApiKey);

payoutRouter.post("/", idempotencyMiddleware(), payoutController.create);
payoutRouter.get("/:id", payoutController.getById);
payoutRouter.get("/", payoutController.list);
