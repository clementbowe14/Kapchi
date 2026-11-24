import { describe, expect, it } from "vitest";
import { PostgresAliasControlLedger } from "./vercel-ledger.js";

describe("PostgresAliasControlLedger", () => {
  const controlId = "a".repeat(64);
  const databaseUrl = (sslmode?: string) => {
    const url = new URL(["postgresql", "//db.invalid/kapchi_gate"].join(":"));
    url.username = "test_user";
    url.password = "test_password";
    if (sslmode) url.searchParams.set("sslmode", sslmode);
    return url.toString();
  };

  it.each([
    databaseUrl(),
    databaseUrl("disable"),
    databaseUrl("no-verify"),
  ])("rejects a control database URL without authenticated TLS: %s", async (databaseUrl) => {
    await expect(PostgresAliasControlLedger.connect(databaseUrl, controlId))
      .rejects.toThrow("authenticated TLS");
  });

  it("rejects a malformed control-plane installation identity before connecting", () => {
    expect(() => new PostgresAliasControlLedger({} as never, "not-an-id"))
      .toThrow("64-character lowercase hex");
  });
});
