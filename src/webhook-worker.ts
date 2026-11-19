import crypto from "crypto";
import { config } from "./modules/common/config";
import { pool } from "./modules/common/db";

async function processOutbox(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const events = await client.query(
      `SELECT id, aggregate_id, event_type, payload
       FROM outbox_events
       WHERE status IN ('PENDING','FAILED')
         AND next_attempt_at <= NOW()
         AND attempt_count < 8
       ORDER BY created_at ASC
       LIMIT 20
       FOR UPDATE SKIP LOCKED`
    );

    for (const event of events.rows) {
      await client.query(
        `UPDATE outbox_events
         SET status='PROCESSING', attempt_count=attempt_count+1, updated_at=NOW()
         WHERE id=$1`,
        [event.id]
      );

      let anyDeliverySucceeded = false;
      let anyDeliveryFailed = false;

      const endpoints = await client.query(
        `SELECT id, merchant_id, url, secret_hash
         FROM webhook_endpoints
         WHERE merchant_id = (SELECT merchant_id FROM payments WHERE id=$1)
           AND active=true`,
        [event.aggregate_id]
      );

      for (const endpoint of endpoints.rows) {
        const body = JSON.stringify({
          id: event.id,
          eventType: event.event_type,
          payload: event.payload,
          sentAt: new Date().toISOString(),
        });
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = crypto
          .createHmac("sha256", endpoint.secret_hash)
          .update(`${timestamp}.${body}`)
          .digest("hex");

        try {
          const response = await fetch(endpoint.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Clearwell-Signature": `t=${timestamp},v1=${signature}`,
            },
            body,
            signal: AbortSignal.timeout(5000),
          });
          const responseBody = await response.text();
          if (response.ok) {
            anyDeliverySucceeded = true;
            await client.query(
              `INSERT INTO webhook_deliveries (endpoint_id,event_id,status,attempt_count,response_status,response_body,updated_at)
               VALUES ($1,$2,'SUCCEEDED',1,$3,$4,NOW())
               ON CONFLICT (endpoint_id,event_id) DO UPDATE SET status='SUCCEEDED', attempt_count=webhook_deliveries.attempt_count+1, response_status=$3, response_body=$4, updated_at=NOW()`,
              [endpoint.id, event.id, response.status, responseBody.slice(0, 4000)]
            );
          } else {
            throw new Error(`Webhook returned HTTP ${response.status}`);
          }
        } catch (error) {
          anyDeliveryFailed = true;
          const message = error instanceof Error ? error.message : "Webhook delivery failed";
          const nextAttempt = new Date(Date.now() + 30_000);
          await client.query(
            `INSERT INTO webhook_deliveries (endpoint_id,event_id,status,attempt_count,last_error,next_attempt_at,updated_at)
             VALUES ($1,$2,'FAILED',1,$3,$4,NOW())
             ON CONFLICT (endpoint_id,event_id) DO UPDATE SET status='FAILED', attempt_count=webhook_deliveries.attempt_count+1, last_error=$3, next_attempt_at=$4, updated_at=NOW()`,
            [endpoint.id, event.id, message, nextAttempt]
          );
        }
      }

      await client.query(
        `UPDATE outbox_events
         SET status='PUBLISHED', published_at=NOW(), updated_at=NOW()
         WHERE id=$1
           AND NOT EXISTS (
             SELECT 1 FROM webhook_deliveries
             WHERE event_id=$1 AND status='FAILED'
           )`,
        [event.id]
      );

      if (anyDeliveryFailed) {
        await client.query(
          `UPDATE outbox_events
           SET status=CASE WHEN attempt_count >= 8 THEN 'DLQ' ELSE 'FAILED' END,
               next_attempt_at=CASE WHEN attempt_count >= 8 THEN next_attempt_at ELSE NOW() + INTERVAL '30 seconds' END,
               updated_at=NOW()
           WHERE id=$1`,
          [event.id]
        );
      } else if (!anyDeliverySucceeded && endpoints.rowCount === 0) {
        await client.query(
          `UPDATE outbox_events
           SET status='PUBLISHED', published_at=NOW(), updated_at=NOW()
           WHERE id=$1`,
          [event.id]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[webhook-worker] outbox cycle failed", error);
  } finally {
    client.release();
  }
}

console.log(`[webhook-worker] Starting worker in ${config.NODE_ENV} mode`);
setInterval(processOutbox, config.WORKER_POLL_INTERVAL_MS);
void processOutbox();
