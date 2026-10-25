import { describe, expect, it } from "vitest";
import { ADMIN_CAPABILITY_MATRIX } from "./capabilities.js";

describe("admin capability matrix", () => {
  it("explicitly covers every shop-manager route family", () => {
    expect(Object.keys(ADMIN_CAPABILITY_MATRIX).sort()).toEqual([
      "assets:read",
      "assets:write",
      "customers:read",
      "fulfillment:write",
      "inventory:read",
      "inventory:write",
      "messages:write",
      "order-notes:write",
      "orders:read",
      "promotions:write",
      "refunds:write",
      "reports:read"
    ]);
  });
});
