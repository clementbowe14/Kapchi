import { describe, expect, it } from "vitest";
import { isAllowedBrowserOrigin, requiresBrowserOrigin } from "./origin-security.js";

describe("origin security", () => {
  const allowed = ["https://shop.kapchi.example"];

  it("uses an exact origin allowlist", () => {
    expect(isAllowedBrowserOrigin("https://shop.kapchi.example", allowed)).toBe(true);
    expect(isAllowedBrowserOrigin("https://shop.kapchi.example.evil.test", allowed)).toBe(false);
    expect(isAllowedBrowserOrigin(undefined, allowed)).toBe(true);
  });

  it("requires an origin for unauthenticated browser mutations", () => {
    expect(requiresBrowserOrigin({ headers: {}, method: "POST", url: "/cart/items" } as never)).toBe(true);
    expect(requiresBrowserOrigin({ headers: { authorization: "Bearer unverified" }, method: "POST", url: "/orders" } as never)).toBe(true);
    expect(requiresBrowserOrigin({ headers: {}, method: "GET", url: "/listings" } as never)).toBe(false);
  });

  it("exempts only authenticated callback routes from browser-origin checks", () => {
    expect(requiresBrowserOrigin({ headers: {}, method: "POST", url: "/payments/webhooks/stripe" } as never)).toBe(false);
    expect(requiresBrowserOrigin({ headers: {}, method: "POST", url: "/assets/upload-completions" } as never)).toBe(false);
    expect(requiresBrowserOrigin({ headers: {}, method: "POST", url: "/payments/checkout-sessions" } as never)).toBe(true);
  });
});
