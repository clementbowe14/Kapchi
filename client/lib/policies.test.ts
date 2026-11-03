import { describe, expect, it } from "vitest";
import { ACTIVE_POLICY_RELEASE, POLICY_RELEASES } from "@/content/generated-policy-manifest";
import { parseCheckoutPolicyBundle, parseCustomerPolicySnapshot, POLICY_KEYS } from "./policies";

describe("policy contracts", () => {
  it("keeps the generated active release complete and append-only-addressable", () => {
    expect(ACTIVE_POLICY_RELEASE.publicationStatus).toBe("draft");
    expect(ACTIVE_POLICY_RELEASE.documents.map((document) => document.key)).toEqual(POLICY_KEYS);
    expect(new Set(POLICY_RELEASES.map((release) => release.bundleVersion)).size).toBe(POLICY_RELEASES.length);
    for (const document of ACTIVE_POLICY_RELEASE.documents) {
      expect(document.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(document.path).toBe(`/policies/${document.key}/${document.version}`);
    }
  });

  it("parses authoritative bundle metadata", () => {
    expect(parseCheckoutPolicyBundle(ACTIVE_POLICY_RELEASE).bundleVersion).toBe("2026-11-03.1");
  });

  it("accepts null historical evidence and rejects malformed snapshots", () => {
    expect(parseCustomerPolicySnapshot(null)).toBeNull();
    expect(() => parseCustomerPolicySnapshot({ schemaVersion: 1, documents: [] })).toThrow("Invalid customer policy snapshot");
  });
});
