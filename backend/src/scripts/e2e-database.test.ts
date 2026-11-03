import { describe, expect, it } from "vitest";
import { assertIsolatedE2eDatabaseUrl } from "./e2e-database.js";

describe("admin order E2E database isolation", () => {
  it.each([
    undefined,
    "postgres://localhost/kapchi_test",
    "postgres://db.example.com/kapchi_e2e",
    "postgres://localhost/kapchi_e2e"
  ])("rejects an unsafe target or shared URL", (value) => {
    expect(() => assertIsolatedE2eDatabaseUrl(value, ["postgres://localhost/kapchi_e2e"]))
      .toThrow();
  });

  it("accepts only a separate loopback _e2e database", () => {
    expect(assertIsolatedE2eDatabaseUrl(
      "postgres://localhost/kapchi_admin_e2e",
      ["postgres://localhost/kapchi_dev"],
    )).toBe("postgres://localhost/kapchi_admin_e2e");
  });
});
