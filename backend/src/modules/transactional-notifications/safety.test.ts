import { describe, expect, it } from "vitest";
import {
  normalizeEmail,
  normalizeSmsNumber,
  sanitizePlainText,
  snapshotRecipient
} from "./safety.js";

describe("transactional notification recipient safety", () => {
  it("normalizes valid checkout snapshots", () => {
    expect(normalizeEmail(" Customer@Example.Test ")).toBe("customer@example.test");
    expect(normalizeSmsNumber("+1 (212) 555-0100")).toBe("+12125550100");
  });

  it("rejects malformed or oversized contacts", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(`${"a".repeat(250)}@example.test`)).toBeNull();
    expect(normalizeSmsNumber("212-555-0100")).toBeNull();
    expect(normalizeSmsNumber("+123")).toBeNull();
  });

  it("never crosses an explicit channel preference", () => {
    expect(snapshotRecipient({
      customerEmail: "broken",
      customerPhone: "+12125550100",
      preferredContactMethod: "email"
    })).toEqual({
      address: null,
      channel: null,
      failureCode: "MESSAGE_CONTACT_UNAVAILABLE"
    });
    expect(snapshotRecipient({
      customerEmail: "customer@example.test",
      customerPhone: "broken",
      preferredContactMethod: "sms"
    })).toEqual({
      address: null,
      channel: null,
      failureCode: "MESSAGE_CONTACT_UNAVAILABLE"
    });
    expect(snapshotRecipient({
      customerEmail: "customer@example.test",
      customerPhone: "+12125550100",
      preferredContactMethod: "phone"
    })).toEqual({
      address: null,
      channel: null,
      failureCode: "MESSAGE_SMS_CONSENT_UNAVAILABLE"
    });
  });

  it("uses email only when no preference is recorded", () => {
    expect(snapshotRecipient({
      customerEmail: "customer@example.test",
      customerPhone: "+12125550100",
      preferredContactMethod: null
    })).toMatchObject({ channel: "email", address: "customer@example.test" });
  });

  it("strips control characters and bounds plain text", () => {
    expect(sanitizePlainText("Title\r\nBcc: private@example.test\u0000", 12)).toBe(
      "Title Bcc: p",
    );
  });
});
