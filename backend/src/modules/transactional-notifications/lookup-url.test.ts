import { describe, expect, it } from "vitest";
import { buildOrderLookupUrl, validateOrderLookupBaseUrl } from "./lookup-url.js";

describe("transactional notification lookup URL", () => {
  it("always builds a fixed unprefilled orders URL", () => {
    expect(buildOrderLookupUrl("https://shop.kapchi.test/some/base", "production"))
      .toBe("https://shop.kapchi.test/orders");
    expect(buildOrderLookupUrl("http://127.0.0.1:3000/base", "test"))
      .toBe("http://127.0.0.1:3000/orders");
  });

  it("rejects credentials, queries, fragments, and unsafe development HTTP", () => {
    for (const value of [
      "https://user:secret@shop.kapchi.test",
      "https://shop.kapchi.test?email=private@example.test",
      "https://shop.kapchi.test#KAP-PRIVATE",
      "http://shop.kapchi.test"
    ]) {
      expect(() => validateOrderLookupBaseUrl(value, "test")).toThrow();
    }
  });

  it("requires HTTPS in production", () => {
    expect(() => validateOrderLookupBaseUrl("http://localhost:3000", "production"))
      .toThrow(/HTTPS/);
  });
});
