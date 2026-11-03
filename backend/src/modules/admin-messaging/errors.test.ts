import { describe, expect, it } from "vitest";
import { canonicalMessageFailureCode } from "./errors.js";

describe("canonicalMessageFailureCode", () => {
  it.each([
    ["GATEWAY_TIMEOUT", "MESSAGE_PROVIDER_TIMEOUT"],
    ["MESSAGE_PROVIDER_HTTP_429", "MESSAGE_PROVIDER_RATE_LIMITED"],
    ["MESSAGE_PROVIDER_HTTP_503", "MESSAGE_PROVIDER_UNAVAILABLE"],
    ["RECIPIENT_REJECTED", "MESSAGE_RECIPIENT_REJECTED"],
    ["provider said customer@example.test bounced", "MESSAGE_PROVIDER_FAILED"],
    [undefined, "MESSAGE_PROVIDER_FAILED"]
  ])("maps %s to a bounded internal code", (input, expected) => {
    expect(canonicalMessageFailureCode(input)).toBe(expected);
  });
});
