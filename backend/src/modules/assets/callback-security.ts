import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type CallbackKey = { expiresAt?: string; id: string; secret: string };
export type CallbackEnvelope = { keyId: string; nonce: string; signature: string; timestamp: string };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function callbackBusinessFingerprint(value: unknown) {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

export function callbackSignature(secret: string, envelope: Omit<CallbackEnvelope, "signature">, body: unknown) {
  const bodyHash = callbackBusinessFingerprint(body);
  return createHmac("sha256", secret).update(`${envelope.keyId}.${envelope.timestamp}.${envelope.nonce}.${bodyHash}`).digest("hex");
}

export function verifyCallbackEnvelope(
  envelope: CallbackEnvelope,
  body: unknown,
  keys: { current?: CallbackKey; previous?: CallbackKey },
  now = Date.now(),
) {
  const key = [keys.current, keys.previous].find((candidate) => candidate?.id === envelope.keyId);
  if (!key || (key.expiresAt && Date.parse(key.expiresAt) <= now)) return false;
  const expected = Buffer.from(callbackSignature(key.secret, envelope, body), "hex");
  const actual = Buffer.from(envelope.signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function callbackTimestampIsFresh(timestamp: string, now = Date.now()) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && Math.abs(now - parsed) <= 5 * 60 * 1000;
}

export function isExpectedVercelBlob(input: { contentType: string; pathname: string; size: number; url: string }, expected: { contentType: string; pathname: string; size: number }) {
  try {
    const url = new URL(input.url);
    return url.protocol === "https:" &&
      (url.hostname.endsWith(".blob.vercel-storage.com") || url.hostname.endsWith(".public.blob.vercel-storage.com")) &&
      input.pathname === expected.pathname &&
      input.contentType === expected.contentType &&
      input.size === expected.size;
  } catch {
    return false;
  }
}
