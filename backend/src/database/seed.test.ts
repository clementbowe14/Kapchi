import { describe, expect, it } from "vitest";
import { assertSafeLocalSeedTarget } from "./seed.js";

describe("assertSafeLocalSeedTarget", () => {
  it("allows localhost PostgreSQL URLs outside production", () => {
    expect(() =>
      assertSafeLocalSeedTarget(
        "postgresql://kapchi:kapchi@localhost:5432/kapchi",
        "development",
      ),
    ).not.toThrow();
  });

  it("refuses production mode", () => {
    expect(() =>
      assertSafeLocalSeedTarget(
        "postgresql://kapchi:kapchi@localhost:5432/kapchi",
        "production",
      ),
    ).toThrow("NODE_ENV=production");
  });

  it("refuses non-local database hosts", () => {
    expect(() =>
      assertSafeLocalSeedTarget(
        "postgresql://kapchi:kapchi@db.example.com:5432/kapchi",
        "development",
      ),
    ).toThrow('Refusing to seed non-local database host "db.example.com"');
  });

  it("requires a PostgreSQL URL", () => {
    expect(() =>
      assertSafeLocalSeedTarget("mysql://localhost/kapchi", "development"),
    ).toThrow("postgres or postgresql");
  });
});
