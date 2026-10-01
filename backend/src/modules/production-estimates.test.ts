import { describe, expect, it } from "vitest";
import {
  parseProductionEstimateSnapshot,
  productionEstimateFingerprint,
  productionEstimateSummary,
  PRODUCTION_ESTIMATE_QUALIFIER,
} from "./production-estimates.js";

const snapshot = {
  maximumBusinessDays: 7,
  minimumBusinessDays: 5,
  priorityCode: "standard",
  priorityLabel: "Standard",
  quotedAt: "2026-10-01T16:00:00.000Z",
  ruleId: "00000000-0000-4000-8000-000000000093",
  ruleRevision: 1,
  schemaVersion: 1,
};

describe("production estimate snapshots", () => {
  it("parses the complete versioned shape and exposes only safe customer fields", () => {
    const parsed = parseProductionEstimateSnapshot(snapshot);

    expect(parsed).toEqual(snapshot);
    expect(productionEstimateSummary(parsed!)).toEqual({
      maximumBusinessDays: 7,
      minimumBusinessDays: 5,
      priorityCode: "standard",
      priorityLabel: "Standard",
      qualifier: PRODUCTION_ESTIMATE_QUALIFIER,
    });
  });

  it.each([
    [{ ...snapshot, maximumBusinessDays: 4 }],
    [{ ...snapshot, priorityCode: "Rush" }],
    [{ ...snapshot, priorityLabel: " Standard" }],
    [{ ...snapshot, quotedAt: "2026-10-01" }],
    [{ ...snapshot, ruleId: "not-a-uuid" }],
    [{ ...snapshot, ruleRevision: 0 }],
    [{ ...snapshot, schemaVersion: 2 }],
  ])("rejects malformed or unsupported snapshots", (value) => {
    expect(parseProductionEstimateSnapshot(value)).toBeNull();
  });

  it("uses rule identity and ranges for line identity, not labels or timestamps", () => {
    const parsed = parseProductionEstimateSnapshot(snapshot)!;
    const cosmeticChange = parseProductionEstimateSnapshot({
      ...snapshot,
      priorityLabel: "Standard production",
      quotedAt: "2026-10-02T16:00:00.000Z",
    })!;
    const ruleChange = parseProductionEstimateSnapshot({
      ...snapshot,
      ruleRevision: 2,
    })!;

    expect(productionEstimateFingerprint(cosmeticChange)).toBe(
      productionEstimateFingerprint(parsed),
    );
    expect(productionEstimateFingerprint(ruleChange)).not.toBe(
      productionEstimateFingerprint(parsed),
    );
  });
});
