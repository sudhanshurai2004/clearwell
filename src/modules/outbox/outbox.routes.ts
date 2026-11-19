import { Router } from "express";
import { z } from "zod";
import { pool } from "../common/db";
import crypto from "crypto";
import { authenticateApiKey } from "../merchant/middleware/authenticateApiKey";

const eventSchema = z.object({
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.any()),
});

export const outboxRouter = Router();

outboxRouter.use(authenticateApiKey);

outboxRouter.post("/endpoints", async (req, res, next) => {
  try {
    const schema = z.object({ url: z.string().url(), secret: z.string().min(16) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_WEBHOOK_ENDPOINT", message: "url and secret are required" });
      return;
    }
    const secretHash = crypto.createHash("sha256").update(parsed.data.secret).digest("hex");
    const result = await pool.query(
      `INSERT INTO webhook_endpoints (merchant_id, url, secret_hash)
       VALUES ($1,$2,$3)
       RETURNING id, url, active, created_at`,
      [req.merchant.id, parsed.data.url, secretHash]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

outboxRouter.post("/events", async (req, res, next) => {
  try {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "INVALID_OUTBOX_EVENT",
        message: parsed.error.issues[0]?.message ?? "Invalid outbox event",
      });
      return;
    }

    const result = await pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,$3,$4)
       RETURNING id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, created_at`,
      [parsed.data.aggregateType, parsed.data.aggregateId, parsed.data.eventType, JSON.stringify(parsed.data.payload)]
    );
    res.status(201).json({ event: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
