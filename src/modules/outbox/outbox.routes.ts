import { Router } from "express";
import { z } from "zod";
import { outboxService } from "./outbox.service";

const eventSchema = z.object({
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.any()),
});

export const outboxRouter = Router();

outboxRouter.post("/events", (req, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      code: "INVALID_OUTBOX_EVENT",
      message: parsed.error.issues[0]?.message ?? "Invalid outbox event",
    });
  }

  const event = outboxService.createEvent(
    parsed.data.aggregateType,
    parsed.data.aggregateId,
    parsed.data.eventType,
    parsed.data.payload
  );

  return res.status(201).json({ event });
});

outboxRouter.post("/publish", async (req, res) => {
  const webhookUrl = String(req.body?.webhookUrl ?? "http://localhost:3001/webhook");
  const signingSecret = String(req.body?.signingSecret ?? "clearwell-webhook-secret");
  const published = await outboxService.processPending(webhookUrl, signingSecret, {
    maxRetries: Number(req.body?.maxRetries ?? 5),
  });
  return res.status(200).json({ publishedCount: published.length, published });
});
