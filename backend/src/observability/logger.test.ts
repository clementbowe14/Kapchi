import { Writable } from "node:stream";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createLoggerOptions } from "./logger.js";

describe("logger redaction", () => {
  it("redacts customer, upload, cookie, and provider data at nested depths", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const app = fastify({
      logger: { ...createLoggerOptions("info"), stream }
    });
    const bypassValue = "vercel-bypass-must-never-appear";
    const providerSecrets = [
      "clerk-secret-must-never-appear",
      "clerk-webhook-must-never-appear",
      "stripe-webhook-must-never-appear",
      "blob-token-must-never-appear",
      "message-token-must-never-appear",
      "identity-control-must-never-appear",
      "cron-secret-must-never-appear"
    ];
    app.get("/", async (request) => {
      request.log.info({
        shippingAddress: { line1: "101 Private Street", postalCode: "12345" },
        customization: { customizationText: "Private stole text", productionNotes: "Private notes" },
        upload: { uploadedMetadata: { filename: "student-name.png" } },
        headers: {
          cookie: "session=private",
          "x-vercel-protection-bypass": bypassValue,
          "x-vercel-set-bypass-cookie": "true"
        },
        req: { headers: { "x-vercel-protection-bypass": bypassValue } },
        request: { headers: { "x-vercel-set-bypass-cookie": bypassValue } },
        bypassSecret: bypassValue,
        identityControlToken: providerSecrets[5],
        cronSecret: providerSecrets[6],
        provider: {
          blobReadWriteToken: providerSecrets[3],
          clerkSecretKey: providerSecrets[0],
          clerkWebhookSecret: providerSecrets[1],
          messageDeliveryToken: providerSecrets[4],
          providerPayload: { customerEmail: "private@example.com" },
          stripeWebhookSecret: providerSecrets[2]
        }
      }, "redaction test");
      return { ok: true };
    });
    await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(output).not.toContain("101 Private Street");
    expect(output).not.toContain("Private stole text");
    expect(output).not.toContain("student-name.png");
    expect(output).not.toContain("session=private");
    expect(output).not.toContain("private@example.com");
    expect(output).not.toContain(bypassValue);
    for (const secret of providerSecrets) expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  });
});
