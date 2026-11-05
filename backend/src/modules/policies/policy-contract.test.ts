import { describe, expect, it } from "vitest";
import {
  activePolicyBundle,
  activePolicyBundleEtag,
  serializePolicySnapshot,
  snapshotForInsertion
} from "./policy-contract.js";

describe("policy contract", () => {
  it("publishes complete deterministic metadata with a strong ETag", () => {
    expect(activePolicyBundle).toMatchObject({
      bundleVersion: "2026-11-03.1",
      effectiveDate: "2026-11-03",
      schemaVersion: 1
    });
    expect(activePolicyBundle.documents.map((document) => document.key)).toEqual([
      "shipping",
      "returns",
      "privacy",
      "terms"
    ]);
    expect(activePolicyBundleEtag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it("serializes only the customer-safe immutable snapshot", () => {
    const policy = snapshotForInsertion();
    const snapshot = serializePolicySnapshot({
      assertions: policy.assertions,
      bundle_version: policy.bundleVersion,
      checkout_statement_digest: policy.checkoutStatement.digest,
      checkout_statement_version: policy.checkoutStatement.version,
      documents: policy.documents,
      effective_date: policy.effectiveDate,
      schema_version: policy.schemaVersion,
      statement_submitted_at: new Date("2026-11-03T12:00:00.000Z")
    });

    expect(snapshot).toEqual({
      bundleVersion: policy.bundleVersion,
      checkoutStatement: policy.checkoutStatement,
      documents: policy.documents,
      effectiveDate: policy.effectiveDate,
      schemaVersion: 1,
      statementSubmittedAt: "2026-11-03T12:00:00.000Z"
    });
    expect(JSON.stringify(snapshot)).not.toContain("assertions");
    expect(JSON.stringify(snapshot)).not.toContain("title");
  });

  it("rejects malformed persisted evidence instead of partially rendering it", () => {
    const policy = snapshotForInsertion();
    expect(() =>
      serializePolicySnapshot({
        assertions: { termsAgreed: true },
        bundle_version: policy.bundleVersion,
        checkout_statement_digest: policy.checkoutStatement.digest,
        checkout_statement_version: policy.checkoutStatement.version,
        documents: policy.documents,
        effective_date: policy.effectiveDate,
        schema_version: policy.schemaVersion,
        statement_submitted_at: "2026-11-03T12:00:00.000Z"
      }),
    ).toThrow("Invalid persisted policy assertion");
  });
});
