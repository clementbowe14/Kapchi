import { describe, expect, it } from "vitest";
import { callbackBusinessFingerprint, callbackSignature, callbackTimestampIsFresh, isExpectedVercelBlob, verifyCallbackEnvelope } from "./callback-security.js";

describe("asset callback security", () => {
  const body = { blob: { pathname: "kapchi/customization_image/id/photo.png", size: 12 }, tokenPayload: { assetId: "id" } };
  const unsigned = { keyId: "current_key", nonce: "nonce-1", timestamp: "2026-11-05T12:00:00.000Z" };
  const keys = { current: { id: "current_key", secret: "s".repeat(32) } };

  it("binds signatures to canonical business fields and verifies in constant-time form", () => {
    const envelope = { ...unsigned, signature: callbackSignature(keys.current.secret, unsigned, body) };
    expect(verifyCallbackEnvelope(envelope, body, keys, Date.parse(unsigned.timestamp))).toBe(true);
    expect(verifyCallbackEnvelope(envelope, { ...body, tokenPayload: { assetId: "altered" } }, keys, Date.parse(unsigned.timestamp))).toBe(false);
    expect(callbackBusinessFingerprint({ b: 2, a: 1 })).toBe(callbackBusinessFingerprint({ a: 1, b: 2 }));
  });

  it("accepts only an unexpired named rotation key", () => {
    const previous = { expiresAt: "2026-11-05T13:00:00.000Z", id: "previous_key", secret: "p".repeat(32) };
    const prior = { ...unsigned, keyId: previous.id };
    const envelope = { ...prior, signature: callbackSignature(previous.secret, prior, body) };
    expect(verifyCallbackEnvelope(envelope, body, { ...keys, previous }, Date.parse(unsigned.timestamp))).toBe(true);
    expect(verifyCallbackEnvelope(envelope, body, { ...keys, previous }, Date.parse("2026-11-05T14:00:00.000Z"))).toBe(false);
  });

  it("bounds first delivery freshness and validates Vercel object metadata", () => {
    expect(callbackTimestampIsFresh("2026-11-05T12:00:00.000Z", Date.parse("2026-11-05T12:04:59.000Z"))).toBe(true);
    expect(callbackTimestampIsFresh("2026-11-05T12:00:00.000Z", Date.parse("2026-11-05T12:06:00.000Z"))).toBe(false);
    expect(isExpectedVercelBlob({ contentType: "image/png", pathname: "kapchi/x.png", size: 12, url: "https://store.public.blob.vercel-storage.com/kapchi/x.png" }, { contentType: "image/png", pathname: "kapchi/x.png", size: 12 })).toBe(true);
    expect(isExpectedVercelBlob({ contentType: "image/png", pathname: "kapchi/x.png", size: 12, url: "https://evil.example/kapchi/x.png" }, { contentType: "image/png", pathname: "kapchi/x.png", size: 12 })).toBe(false);
  });
});
