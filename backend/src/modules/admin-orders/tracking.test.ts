import { describe, expect, it } from "vitest";
import { confirmedTrackingIdentity, deriveTrackingUrl, normalizeCarrier } from "./tracking.js";

describe("customer-safe carrier tracking", () => {
  it.each([
    [" united states postal service ", "USPS", "https://tools.usps.com/go/TrackConfirmAction?tLabels=A%20B-1"],
    ["United Parcel Service", "UPS", "https://www.ups.com/track?tracknum=A%20B-1"],
    ["Fed Ex", "FedEx", "https://www.fedex.com/fedextrack/?trknbr=A%20B-1"],
    ["DHL Express", "DHL", "https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=A%20B-1"]
  ])("normalizes %s and derives a frozen HTTPS URL", (alias, canonical, expected) => {
    expect(normalizeCarrier(alias)).toBe(canonical);
    expect(deriveTrackingUrl(alias, "A B-1")).toBe(expected);
  });

  it("does not make unknown carriers clickable", () => {
    expect(normalizeCarrier(" Local Courier ")).toBe("Local Courier");
    expect(deriveTrackingUrl("Local Courier", "ABC123")).toBeNull();
  });

  it("compares tracking after removing spaces and hyphens", () => {
    expect(confirmedTrackingIdentity("usps", "ab-12 3"))
      .toBe(confirmedTrackingIdentity("USPS", "AB123"));
  });
});
