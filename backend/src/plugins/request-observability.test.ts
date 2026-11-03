import { Writable } from "node:stream";
import fastify, { LogController } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createLoggerOptions } from "../observability/logger.js";
import {
  createRequestObservabilityPlugin,
  generateRequestId
} from "./request-observability.js";

function buildTestServer(now: () => number = () => performance.now()) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    }
  });
  const app = fastify({
    genReqId: generateRequestId,
    logger: {
      ...createLoggerOptions("info"),
      stream
    },
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "requestId"
    })
  });

  return {
    app,
    lines,
    register: () =>
      app.register(createRequestObservabilityPlugin({ clock: { now } }))
  };
}

function parsedLogs(lines: string[]) {
  return lines
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("request observability", () => {
  it("preserves a valid request ID and returns it in the response", async () => {
    const { app, register } = buildTestServer();
    await register();
    app.get("/health", async () => ({ ok: true }));

    const response = await app.inject({
      headers: { "x-request-id": "frontend:checkout-123" },
      method: "GET",
      url: "/health"
    });

    expect(response.headers["x-request-id"]).toBe("frontend:checkout-123");
    await app.close();
  });

  it("accepts a correlation ID fallback and replaces invalid input", async () => {
    const { app, register } = buildTestServer();
    await register();
    app.get("/health", async () => ({ ok: true }));

    const correlated = await app.inject({
      headers: { "x-correlation-id": "mobile/order.456" },
      method: "GET",
      url: "/health"
    });
    const generated = await app.inject({
      headers: { "x-request-id": "invalid id with spaces" },
      method: "GET",
      url: "/health"
    });

    expect(correlated.headers["x-request-id"]).toBe("mobile/order.456");
    expect(generated.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await app.close();
  });

  it("logs completion with route, status, and measured duration", async () => {
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(42);
    const { app, lines, register } = buildTestServer(now);
    await register();
    app.get("/widgets/:id", async (_request, reply) => {
      return reply.code(202).send({ accepted: true });
    });

    await app.inject({ method: "GET", url: "/widgets/7?private=value" });

    const completion = parsedLogs(lines).find(
      (entry) => entry.event === "http.request.completed",
    );
    expect(completion).toMatchObject({
      durationMs: 32,
      method: "GET",
      route: "/widgets/:id",
      statusCode: 202,
      url: "/widgets/7"
    });
    expect(completion?.requestId).toEqual(expect.any(String));
    const completionLine = lines.find((line) =>
      line.includes('"event":"http.request.completed"'),
    );
    expect(completionLine?.match(/"requestId":/g)).toHaveLength(1);
    await app.close();
  });

  it("logs failures without serializing the error message", async () => {
    let timestamp = 0;
    const { app, lines, register } = buildTestServer(() => {
      timestamp += 5;
      return timestamp;
    });
    await register();
    app.get("/failure", async () => {
      throw new Error("provider said sk_test_do_not_log");
    });

    const response = await app.inject({ method: "GET", url: "/failure" });

    const failure = parsedLogs(lines).find(
      (entry) => entry.event === "http.request.failed",
    );
    expect(response.statusCode).toBe(500);
    expect(failure).toMatchObject({
      errorType: "Error",
      method: "GET",
      route: "/failure",
      statusCode: 500
    });
    expect(lines.join("")).not.toContain("sk_test_do_not_log");
    await app.close();
  });

  it("logs handled server failures that do not throw", async () => {
    const { app, lines, register } = buildTestServer();
    await register();
    app.get("/provider-failure", async (_request, reply) => {
      return reply.code(502).send({ error: "CHECKOUT_PROVIDER_ERROR" });
    });

    await app.inject({ method: "GET", url: "/provider-failure" });

    const failures = parsedLogs(lines).filter(
      (entry) => entry.event === "http.request.failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      method: "GET",
      route: "/provider-failure",
      statusCode: 502
    });
    await app.close();
  });

  it("redacts authentication, contact, payment, body, and secret fields", async () => {
    const { app, lines, register } = buildTestServer();
    await register();
    app.get("/redaction", async (request) => {
      request.log.info(
        {
          authorization: "Bearer auth-token-value",
          body: { webhookPayload: "raw-webhook-value" },
          config: { payments: { secretKey: "sk_test_private" } },
          headers: {
            cookie: "session_id=cookie-value",
            "stripe-signature": "stripe-signature-value"
          },
          payment: {
            card: "4242424242424242",
            customerEmail: "customer@example.com",
            customerPhone: "+15555550123",
            clientSecret: "pi_secret_private"
          },
          notification: {
            from: "support-private@example.com",
            lookupUrl: "https://shop.test/orders?secret=value",
            recipientAddress: "recipient-private@example.com",
            subject: "Private order subject",
            to: "+15555550999",
            trackingNumber: "TRACK-PRIVATE-123",
            trackingUrl: "https://carrier.test/TRACK-PRIVATE-123"
          }
        },
        "redaction-test",
      );

      return { ok: true };
    });

    await app.inject({ method: "GET", url: "/redaction" });

    const output = lines.join("");
    expect(output).toContain("[REDACTED]");
    for (const sensitiveValue of [
      "auth-token-value",
      "raw-webhook-value",
      "sk_test_private",
      "cookie-value",
      "stripe-signature-value",
      "4242424242424242",
      "customer@example.com",
      "+15555550123",
      "pi_secret_private",
      "support-private@example.com",
      "https://shop.test/orders?secret=value",
      "recipient-private@example.com",
      "Private order subject",
      "+15555550999",
      "TRACK-PRIVATE-123",
      "https://carrier.test/TRACK-PRIVATE-123"
    ]) {
      expect(output).not.toContain(sensitiveValue);
    }
    await app.close();
  });
});
