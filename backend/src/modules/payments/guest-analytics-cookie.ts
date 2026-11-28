import { createHmac, timingSafeEqual } from "node:crypto";

const maxAge = 90 * 24 * 60 * 60;
const cookieVersion = "v1";
const encodedKeyLength = 43;
const encodedDigestPattern = /^[A-Za-z0-9_-]{43}$/;
const maxCookieLength = cookieVersion.length + 3 + 16 + 2 * encodedKeyLength;

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`kapchi:guest-analytics-cookie:${payload}`)
    .digest("base64url");
}

function epochSeconds(now: Date) {
  return Math.floor(now.getTime() / 1000);
}

export function guestAnalyticsCookieSettings(secure: boolean) {
  return {
    name: secure ? "__Host-kapchi_guest_analytics" : "kapchi_guest_analytics",
    options: { httpOnly: true, path: "/", sameSite: "lax", secure },
    maxAge
  } as const;
}

export function signGuestAnalyticsCookie(key: string, secret: string, now: Date) {
  const payload = `${cookieVersion}.${epochSeconds(now) + maxAge}.${key}`;
  return `${payload}.${signature(payload, secret)}`;
}

export function readGuestAnalyticsCookie(
  value: string | undefined,
  secret: string,
  now: Date,
): string | undefined {
  if (!value || value.length > maxCookieLength) return undefined;

  const [version, expires, key, mac, ...extra] = value.split(".");
  if (
    extra.length || version !== cookieVersion ||
    !expires || !/^[1-9][0-9]{0,15}$/.test(expires) ||
    key?.length !== encodedKeyLength || !encodedDigestPattern.test(key) ||
    mac?.length !== encodedKeyLength || !encodedDigestPattern.test(mac)
  ) return undefined;

  const expiresAt = Number(expires);
  const currentTime = epochSeconds(now);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= currentTime || expiresAt > currentTime + maxAge) {
    return undefined;
  }

  const expected = signature(`${version}.${expires}.${key}`, secret);
  return timingSafeEqual(Buffer.from(mac, "ascii"), Buffer.from(expected, "ascii"))
    ? key
    : undefined;
}
