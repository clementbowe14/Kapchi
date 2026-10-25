import { describe, expect, it } from "vitest";
import { escapeOrderSearch } from "./repository.js";

describe("admin order search helpers", () => {
  it("escapes LIKE wildcard and escape characters", () => {
    expect(escapeOrderSearch("50%_off\\today")).toBe("50\\%\\_off\\\\today");
  });
});
