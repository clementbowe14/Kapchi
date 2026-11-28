import { describe, expect, it } from "vitest";
import {
  guestAnalyticsCookieSettings,
  readGuestAnalyticsCookie,
  signGuestAnalyticsCookie
} from "./guest-analytics-cookie.js";

const secret = "synthetic-cookie-secret-for-tests-only";
const key = Buffer.alloc(32, 42).toString("base64url");
const now = new Date("2026-11-27T12:00:00Z");

describe("guest analytics cookie", () => {
  it("uses a host-only secure cookie for HTTPS and a distinct HTTP test name", () => {
    expect(guestAnalyticsCookieSettings(true)).toEqual({
      name: "__Host-kapchi_guest_analytics",
      maxAge: 7776000,
      options: { httpOnly: true, path: "/", sameSite: "lax", secure: true }
    });
    expect(guestAnalyticsCookieSettings(false)).toMatchObject({
      name: "kapchi_guest_analytics",
      options: { secure: false }
    });
  });

  it("accepts the signed key until the absolute expiry boundary", () => {
    const cookie = signGuestAnalyticsCookie(key, secret, now);
    const expiry = now.getTime() + 90 * 24 * 60 * 60 * 1000;
    expect(readGuestAnalyticsCookie(cookie, secret, new Date(expiry - 1))).toBe(key);
    expect(readGuestAnalyticsCookie(cookie, secret, new Date(expiry))).toBeUndefined();
    expect(readGuestAnalyticsCookie(cookie, secret, new Date(now.getTime() - 1000))).toBeUndefined();
    expect(readGuestAnalyticsCookie(cookie, `${secret}-rotated`, now)).toBeUndefined();
  });

  it("rejects malformed, overlong, and tampered values", () => {
    const value = signGuestAnalyticsCookie(key, secret, now);
    const [version, expiry, , mac] = value.split(".");
    const changedKey = Buffer.alloc(32, 43).toString("base64url");
    const changedMac = `${mac![0] === "A" ? "B" : "A"}${mac!.slice(1)}`;
    for (const invalid of [
      undefined, "", "x".repeat(4096), `${value}.extra`, value.slice(0, -1),
      `v2.${expiry}.${key}.${mac}`, `${version}.1e9.${key}.${mac}`,
      `${version}.${expiry}.${changedKey}.${mac}`, `${version}.${expiry}.${key}.${changedMac}`
    ]) {
      expect(readGuestAnalyticsCookie(invalid, secret, now)).toBeUndefined();
    }
  });
});
