import { describe, expect, it } from "vitest";
import { ScenarioResultCollector } from "../e2e/staging/scenario-reporter";

const assertions = new Map([["CART-GUEST-CRUD", [
  "CART-GUEST-CRUD:assertion:1",
  "CART-GUEST-CRUD:assertion:2",
]]]);
const interval = {
  finishedAt: "2026-11-23T12:00:00.009Z",
  startedAt: "2026-11-23T12:00:00.000Z",
};

describe("staging scenario reporter", () => {
  it("passes only when the declared owner project executes successfully", () => {
    const collector = new ScenarioResultCollector();
    collector.observe({
      ...interval,
      assertionIdsByScenario: assertions,
      ids: ["CART-GUEST-CRUD"],
      ownerProject: "guest",
      project: "customer",
      status: "skipped",
      testId: "[CART-GUEST-CRUD] [CATALOG-FABRIC] persists add, quantity update, and removal",
    });
    collector.observe({
      ...interval,
      assertionIdsByScenario: assertions,
      ids: ["CART-GUEST-CRUD"],
      ownerProject: "guest",
      project: "guest",
      status: "passed",
      testId: "[CART-GUEST-CRUD] [CATALOG-FABRIC] persists add, quantity update, and removal",
    });
    expect(collector.finalize()).toEqual([{
      assertionIds: assertions.get("CART-GUEST-CRUD"),
      ...interval,
      outcome: "passed",
      scenarioId: "CART-GUEST-CRUD",
      testId: "[CART-GUEST-CRUD] [CATALOG-FABRIC] persists add, quantity update, and removal",
    }]);
  });

  it.each([
    ["skipped", "skipped"],
    ["failed", "failed"],
    ["timedOut", "failed"],
    ["interrupted", "failed"],
  ] as const)("records the owner result %s as %s", (status, outcome) => {
    const collector = new ScenarioResultCollector();
    collector.observe({
      ...interval,
      assertionIdsByScenario: new Map([["CHECKOUT-CANCEL-DECLINE", ["CHECKOUT-CANCEL-DECLINE:assertion:1"]]]),
      ids: ["CHECKOUT-CANCEL-DECLINE"],
      ownerProject: "guest",
      project: "guest",
      status,
      testId: "checkout test",
    });
    expect(collector.finalize()[0]).toMatchObject({ outcome });
  });

  it("fails missing ownership and unexpected non-owner execution", () => {
    for (const input of [
      { ownerProject: undefined, project: "guest" },
      { ownerProject: "guest", project: "admin" },
    ]) {
      const collector = new ScenarioResultCollector();
      collector.observe({
        ...interval,
        assertionIdsByScenario: new Map([["ORDER-CUSTOMER-LOOKUP", ["ORDER-CUSTOMER-LOOKUP:assertion:1"]]]),
        ids: ["ORDER-CUSTOMER-LOOKUP"],
        ...input,
        status: "passed",
        testId: "order lookup test",
      });
      expect(collector.finalize()[0]).toMatchObject({ outcome: "failed" });
    }
  });
});
