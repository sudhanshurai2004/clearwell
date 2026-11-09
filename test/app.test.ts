import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

describe("Express App Foundation & Middleware", () => {
  const app = createApp();

  it("should return 200 and correlation_id on GET /health", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.correlation_id).toBeDefined();
    expect(res.headers["x-correlation-id"]).toBe(res.body.correlation_id);
  });

  it("should show a readable health status page in browsers", async () => {
    const res = await request(app).get("/health").set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("API is healthy");
  });

  it("should keep machine-readable health JSON available to monitoring", async () => {
    const res = await request(app).get("/health?format=json").set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("should show an API landing page at GET /", async () => {
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Clearwell API");
    expect(res.text).toContain("not a merchant dashboard");
  });

  it("should propagate client provided x-correlation-id", async () => {
    const customCorrelationId = "test-corr-id-12345";
    const res = await request(app)
      .get("/health")
      .set("x-correlation-id", customCorrelationId);

    expect(res.status).toBe(200);
    expect(res.body.correlation_id).toBe(customCorrelationId);
    expect(res.headers["x-correlation-id"]).toBe(customCorrelationId);
  });

  it("should return standard error envelope for 404 unknown route", async () => {
    const res = await request(app).get("/v1/non-existent-route");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "Route GET /v1/non-existent-route not found",
    });
    expect(res.body.error.correlation_id).toBeDefined();
  });

  it("should return 400 with VALIDATION_ERROR for invalid request body on POST /v1/merchants", async () => {
    const res = await request(app)
      .post("/v1/merchants")
      .send({ email: "not-an-email" }); // missing name, invalid email

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.correlation_id).toBeDefined();
    expect(res.body.error.details).toBeDefined();
  });
});
