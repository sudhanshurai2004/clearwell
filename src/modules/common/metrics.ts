import client, { Counter, Histogram, Registry } from "prom-client";

export const metricsRegistry = new Registry();
client.collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestCounter = new Counter({
  name: "clearwell_http_requests_total",
  help: "Total Clearwell HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: "clearwell_http_request_duration_seconds",
  help: "Clearwell HTTP request duration",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});
