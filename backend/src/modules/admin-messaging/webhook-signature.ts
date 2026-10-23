import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MessagingWebhookInput } from "./types.js";

function canonical(input: MessagingWebhookInput) {
  return JSON.stringify({
    body: input.body ?? null,
    channel: input.channel,
    errorCode: input.errorCode ?? null,
    eventId: input.eventId,
    from: input.from ?? null,
    providerMessageId: input.providerMessageId ?? null,
    subject: input.subject ?? null,
    threadKey: input.threadKey,
    timestamp: input.timestamp,
    to: input.to ?? null,
    type: input.type
  });
}

export function messagingPayloadHash(input: MessagingWebhookInput) {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

export function signMessagingWebhook(
  input: MessagingWebhookInput,
  secret: string,
) {
  return createHmac("sha256", secret).update(canonical(input)).digest("hex");
}

export function verifyMessagingWebhook(
  input: MessagingWebhookInput,
  signature: string | undefined,
  secret: string | undefined,
  now = Date.now(),
) {
  if (!signature || !secret) return false;
  if (Math.abs(now - input.timestamp * 1000) > 5 * 60 * 1000) return false;

  const expected = Buffer.from(signMessagingWebhook(input, secret), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
