import { describe, expect, it } from "vitest";
import { normalizePermissions, normalizeStoreRoles } from "./claims.js";

describe("verified Clerk claim normalization", () => {
  it("does not promote a Clerk organization administrator to store admin", () => {
    expect(normalizeStoreRoles({ org_role: "admin" })).toEqual([]);
    expect(normalizeStoreRoles({ org_role: "org:admin" })).toEqual([]);
  });

  it("normalizes only explicit store roles from trusted role claims", () => {
    expect(normalizeStoreRoles({
      public_metadata: { roles: ["admin", "admin"] },
      role: "customer",
      roles: ["support"]
    })).toEqual(["support", "customer", "admin"]);
  });

  it("keeps permission claims separate from store roles", () => {
    expect(normalizePermissions({
      org_role: "org:admin",
      permissions: ["orders:refund", "assets:write"]
    })).toEqual(["orders:refund", "assets:write"]);
  });
});
