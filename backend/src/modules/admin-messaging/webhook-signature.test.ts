import { describe, expect, it } from "vitest";
import {
  messagingPayloadHash,
  signMessagingWebhook,
  verifyMessagingWebhook
} from "./webhook-signature.js";

const input = {
  body: "Can you update the embroidery?",
  channel: "email" as const,
  eventId: "event-1",
  from: "customer@example.test",
  providerMessageId: "provider-1",
  threadKey: "kapchi-order:order-id",
  timestamp: 1_800_000_000,
  type: "message.received" as const
};

describe("messaging webhook signatures", () => {
  it("accepts a current exact payload and rejects tampering", () => {
    const signature = signMessagingWebhook(input, "test-secret");
    const now = input.timestamp * 1000;

    expect(verifyMessagingWebhook(input, signature, "test-secret", now)).toBe(true);
    expect(verifyMessagingWebhook(
      { ...input, body: "tampered" },
      signature,
      "test-secret",
      now,
    )).toBe(false);
  });

  it("rejects stale deliveries and creates stable hashes", () => {
    const signature = signMessagingWebhook(input, "test-secret");
    expect(verifyMessagingWebhook(
      input,
      signature,
      "test-secret",
      input.timestamp * 1000 + 6 * 60 * 1000,
    )).toBe(false);
    expect(messagingPayloadHash(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(messagingPayloadHash(input)).toBe(messagingPayloadHash({ ...input }));
  });
});
