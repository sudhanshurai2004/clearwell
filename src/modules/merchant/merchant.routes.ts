import { Router } from "express";
import { merchantController } from "./merchant.controller";
import { authenticateApiKey } from "./middleware/authenticateApiKey";

export const merchantRouter = Router();

// Public route: merchant onboarding
merchantRouter.post("/", merchantController.onboard);

// Authenticated routes: requiring Bearer API key
merchantRouter.get("/me", authenticateApiKey, merchantController.getMe);
merchantRouter.get("/:id", authenticateApiKey, merchantController.getById);
