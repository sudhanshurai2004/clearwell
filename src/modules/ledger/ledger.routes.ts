import { Router } from "express";
import { ledgerController } from "./ledger.controller";
import { authenticateApiKey } from "../merchant/middleware/authenticateApiKey";

export const ledgerRouter = Router();

// Merchant balance endpoint
ledgerRouter.get("/balance", authenticateApiKey, ledgerController.getMyBalance);

// Account ledger query endpoint
ledgerRouter.get("/:id/ledger", authenticateApiKey, ledgerController.getAccountBalance);
