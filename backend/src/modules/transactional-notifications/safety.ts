import type { RecipientSnapshot } from "./types.js";

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/g;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const e164Pattern = /^\+[1-9]\d{7,14}$/;

export function sanitizePlainText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(controlCharacters, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

export function normalizeEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() ?? "";
  return email.length <= 254 && emailPattern.test(email) ? email : null;
}

export function normalizeSmsNumber(value: string | null | undefined) {
  const compact = value?.trim().replace(/[\s().-]/g, "") ?? "";
  return e164Pattern.test(compact) ? compact : null;
}

export function snapshotRecipient(input: {
  customerEmail: string | null;
  customerPhone: string | null;
  preferredContactMethod: "email" | "sms" | "phone" | null;
}): RecipientSnapshot {
  if (input.preferredContactMethod === "phone") {
    return {
      address: null,
      channel: null,
      failureCode: "MESSAGE_SMS_CONSENT_UNAVAILABLE"
    };
  }

  if (input.preferredContactMethod === "sms") {
    const phone = normalizeSmsNumber(input.customerPhone);
    return phone
      ? { address: phone, channel: "sms", failureCode: null }
      : { address: null, channel: null, failureCode: "MESSAGE_CONTACT_UNAVAILABLE" };
  }

  const email = normalizeEmail(input.customerEmail);
  return email
    ? { address: email, channel: "email", failureCode: null }
    : { address: null, channel: null, failureCode: "MESSAGE_CONTACT_UNAVAILABLE" };
}
