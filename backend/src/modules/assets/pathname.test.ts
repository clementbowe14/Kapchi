import { describe, expect, it } from "vitest";
import {
  buildAssetPathname,
  hasValidCustomizationAssetBinding,
  isCanonicalCustomizationPathname,
  sanitizeAssetFilename
} from "./pathname.js";

const assetId = "11111111-1111-4111-8111-111111111111";

describe("asset pathname contract", () => {
  it("builds a stable provider-neutral pathname", () => {
    expect(
      buildAssetPathname("customization_image", assetId, "My Crest (Final).PNG"),
    ).toBe(`kapchi/customization_image/${assetId}/my-crest-final-.png`);
  });

  it.each([".", "..", " / ", "\\", "\u0000"])(
    "never creates a dot or empty filename segment from %j",
    (filename) => {
      expect(sanitizeAssetFilename(filename)).toBe("upload");
    },
  );

  it("requires the expected pathname and embedded asset id to agree", () => {
    const pathname = `kapchi/customization_image/${assetId}/crest.png`;
    expect(
      hasValidCustomizationAssetBinding({
        assetId,
        expectedPathname: pathname,
        storageKey: pathname
      }),
    ).toBe(true);
    expect(
      hasValidCustomizationAssetBinding({
        assetId,
        expectedPathname: pathname,
        storageKey: pathname.replace(assetId, "22222222-2222-4222-8222-222222222222")
      }),
    ).toBe(false);
  });

  it.each([
    `kapchi/customization_image/${assetId}/../crest.png`,
    `kapchi/customization_image/${assetId}/crest%2fother.png`,
    `kapchi/customization_image/${assetId}/crest.png?token=private`,
    `kapchi\\customization_image\\${assetId}\\crest.png`,
    `https://blob.test/kapchi/customization_image/${assetId}/crest.png`
  ])("rejects non-canonical storage key %s", (pathname) => {
    expect(isCanonicalCustomizationPathname(pathname, assetId)).toBe(false);
  });
});
