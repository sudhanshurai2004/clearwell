import crypto from "crypto";

export type OutboxStatus = "PENDING" | "PROCESSING" | "PUBLISHED" | "FAILED";

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retries: number;
  createdAt: Date;
  nextRetryAt?: Date | null;
  lastError?: string | null;
}

export interface WebhookDeliveryResult {
  accepted: boolean;
  statusCode: number;
  body: string;
}

export class OutboxService {
  private readonly events = new Map<string, OutboxEvent>();

  createEvent(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): OutboxEvent {
    const event: OutboxEvent = {
      id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      aggregateType,
      aggregateId,
      eventType,
      payload,
      status: "PENDING",
      retries: 0,
      createdAt: new Date(),
      nextRetryAt: new Date(),
    };
    this.events.set(event.id, event);
    return event;
  }

  listPending(): OutboxEvent[] {
    return Array.from(this.events.values()).filter((event) => event.status === "PENDING");
  }

  async processPending(
    webhookUrl: string,
    signingSecret: string,
    options: { maxRetries?: number } = {}
  ): Promise<OutboxEvent[]> {
    const maxRetries = options.maxRetries ?? 5;
    const pending = this.listPending();
    const results: OutboxEvent[] = [];

    for (const event of pending) {
      try {
        const payload = JSON.stringify({
          id: event.id,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          payload: event.payload,
          sentAt: new Date().toISOString(),
        });

        event.status = "PROCESSING";
        const delivery = await this.deliverWebhook(webhookUrl, payload, signingSecret);

        if (delivery.accepted) {
          event.status = "PUBLISHED";
          event.nextRetryAt = null;
          results.push(event);
          continue;
        }

        event.retries += 1;
        event.lastError = `HTTP ${delivery.statusCode}`;
        event.status = event.retries >= maxRetries ? "FAILED" : "PENDING";
        event.nextRetryAt = new Date(Date.now() + 1000 * 2 ** event.retries);
      } catch (error) {
        event.retries += 1;
        event.status = event.retries >= maxRetries ? "FAILED" : "PENDING";
        event.lastError = error instanceof Error ? error.message : "Webhook delivery failed";
        event.nextRetryAt = new Date(Date.now() + 1000 * 2 ** event.retries);
      }
    }

    return results;
  }

  signPayload(payload: string, secret: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payloadWithTimestamp = `${timestamp}.${payload}`;
    const signature = crypto.createHmac("sha256", secret).update(payloadWithTimestamp).digest("hex");
    return `t=${timestamp},v1=${signature}`;
  }

  verifySignature(payload: string, signature: string, secret: string): boolean {
    const expected = this.signPayload(payload, secret);
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  }

  private async deliverWebhook(
    webhookUrl: string,
    payload: string,
    signingSecret: string
  ): Promise<WebhookDeliveryResult> {
    const headers = {
      "Content-Type": "application/json",
      "X-Clearwell-Signature": this.signPayload(payload, signingSecret),
      "X-Clearwell-Event-Time": new Date().toISOString(),
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: payload,
    });

    const body = await response.text();
    return {
      accepted: response.ok,
      statusCode: response.status,
      body,
    };
  }
}

export const outboxService = new OutboxService();
