import { describe, expect, it } from "vitest";
import { reviewedScenarioIds } from "./scenario-reporter";

describe("staging scenario ownership", () => {
  it("matches the exact observability owner title", () => {
    expect(reviewedScenarioIds(
      "[OBS-CORRELATION-REDACTION] proves correlation and redaction from captured backend logs",
    )).toEqual(["OBS-CORRELATION-REDACTION"]);
  });

  it("emits fixture cleanup evidence from its exact reviewed owner", () => {
    expect(reviewedScenarioIds(
      "[CART-GUEST-CRUD] [CATALOG-FABRIC] persists add, quantity update, and removal",
    )).toEqual([
      "CART-GUEST-CRUD",
      "CATALOG-FABRIC",
      "FIXTURE-ISOLATION-CLEANUP",
    ]);
  });
});
