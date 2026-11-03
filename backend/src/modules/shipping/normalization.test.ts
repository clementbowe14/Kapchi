import { describe, expect, it } from "vitest";
import { normalizePackage, normalizePhone, normalizeText, normalizeUsAddress, safeRoutingText } from "./normalization.js";

describe("shipping export normalization", () => {
  it("normalizes Unicode whitespace and controls before validation", () => {
    expect(normalizeText("  Jose\u0301\t\n  Example  ")).toBe("José Example");
  });

  it.each(["=SUM(1,1)", "+cmd", "-2+3", "@value"])(
    "rejects formula-like routing data: %s",
    (value) => {
      expect(() => safeRoutingText(value, "line1", 128)).toThrowError(
        expect.objectContaining({ code: "EXPORT_ADDRESS_INCOMPLETE" }),
      );
    },
  );

  it("preserves U.S. ZIP leading zeroes and normalizes address casing", () => {
    expect(normalizeUsAddress({
      city: " Boston ", country: "us", line1: "123 Main", postalCode: "02108", state: "ma"
    })).toEqual({
      city: "Boston", country: "US", line1: "123 Main", postalCode: "02108", state: "MA"
    });
  });

  it("rejects international and malformed U.S. destinations", () => {
    expect(() => normalizeUsAddress({
      city: "Toronto", country: "CA", line1: "1 King", postalCode: "M5H", state: "ON"
    })).toThrowError(expect.objectContaining({ code: "EXPORT_INTERNATIONAL_UNSUPPORTED" }));
    expect(() => normalizeUsAddress({
      city: "Boston", country: "US", line1: "1 Main", postalCode: "2108", state: "MA"
    })).toThrowError(expect.objectContaining({ code: "EXPORT_ADDRESS_INCOMPLETE" }));
  });

  it("normalizes E.164-style phones without treating plus as a formula", () => {
    expect(normalizePhone("+1 (617) 555-0100")).toBe("6175550100");
  });

  it("canonicalizes package decimals and rejects excess precision", () => {
    expect(normalizePackage({
      heightInches: 2, lengthInches: 10.5, weightOunces: 12.25, widthInches: 8
    })).toMatchObject({
      heightInches: "2", lengthInches: "10.5", weightOunces: "12.25", widthInches: "8"
    });
    expect(() => normalizePackage({
      heightInches: 2, lengthInches: 10.555, weightOunces: 12, widthInches: 8
    })).toThrowError(expect.objectContaining({ code: "EXPORT_PACKAGE_INVALID" }));
  });
});
