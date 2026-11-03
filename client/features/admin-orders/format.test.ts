import { describe, expect, it } from "vitest";
import {
  customizationImageStatus,
  customizationLevel,
  formatAddress,
  formatAdminMoney,
  formatProductionEstimate,
  formatProductionSelection,
  snapshotLabel,
  statusLabel,
} from "./format";
import { createAdminOrderDetail } from "./test-fixtures";

describe("admin order formatting", () => {
  it("formats minor units without combining currencies", () => {
    expect(formatAdminMoney({ amountMinor: 12345, currency: "USD" })).toBe("$123.45");
    expect(formatAdminMoney({ amountMinor: 12345, currency: "JPY" })).toBe("¥12,345");
    expect(formatAdminMoney({ amountMinor: 12345, currency: "KWD" })).toContain("12.345");
    expect(formatAdminMoney({ amountMinor: 12345, currency: "invalid" })).toBe("Not available");
  });

  it("humanizes statuses", () => {
    expect(statusLabel("ready_to_ship")).toBe("Ready To Ship");
  });

  it("reads only allowlisted snapshot and production fields", () => {
    const item = createAdminOrderDetail().items[0];
    expect(snapshotLabel(item.snapshots.listing, ["title"])).toBe("Classic graduation stole");
    expect(customizationLevel(item.snapshots.customization)).toBe("Text (long) + Image + Trim");
    expect(customizationImageStatus(item)).toBe("Selected");
    expect(formatProductionSelection("font", item.production.font, "present")).toBe("Garamond");
    expect(formatProductionSelection("font", "00000000-0000-4000-8000-000000000001", "present"))
      .toBe("Stored selection");
    expect(formatProductionSelection("trim", "Local Gold Trim", "present"))
      .toBe("Local Gold Trim");
    expect(formatProductionSelection("font", "font_01ABCDEF", "present"))
      .toBe("Stored selection");
    expect(formatProductionSelection("trim", { stripePriceId: "private" }, "present")).toBe("Stored selection");
  });

  it("formats only approved production estimate fields", () => {
    expect(formatProductionEstimate({
      maximumBusinessDays: 7,
      minimumBusinessDays: 5,
      priorityLabel: "Standard",
      ruleId: "private",
    })).toBe("Standard: 5-7 business days");
  });

  it("distinguishes missing production states", () => {
    expect(formatProductionSelection("trim", null, "not_selected")).toBe("Not selected");
    expect(formatProductionSelection("trim", null, "not_stored")).toBe("Not stored");
  });

  it("formats only approved shipping address fields", () => {
    expect(formatAddress({ line1: "100 Main", city: "Lima", secret: "hidden" }))
      .toEqual(["100 Main", "Lima"]);
  });
});
