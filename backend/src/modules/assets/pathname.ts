export type AssetPathContext =
  | "customization_image"
  | "catalog_listing_image"
  | "fabric_image";

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function sanitizeAssetFilename(filename: string) {
  const normalized = filename
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 128)
    .replace(/[._-]+$/g, "");

  return normalized || "upload";
}

export function buildAssetPathname(
  context: AssetPathContext,
  assetId: string,
  filename: string,
) {
  return ["kapchi", context, assetId, sanitizeAssetFilename(filename)].join("/");
}

export function isCanonicalCustomizationPathname(
  pathname: string,
  assetId: string,
) {
  if (
    pathname.includes("\\") ||
    pathname.includes("%") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(pathname)
  ) {
    return false;
  }

  const pattern = new RegExp(
    `^kapchi/customization_image/${UUID_PATTERN}/[a-z0-9][a-z0-9._-]{0,127}$`,
    "i",
  );
  const match = pathname.match(pattern);

  return match !== null && pathname.split("/")[2]?.toLowerCase() === assetId.toLowerCase();
}

export function hasValidCustomizationAssetBinding(input: {
  assetId: string;
  expectedPathname: string | null;
  storageKey: string | null;
}) {
  return input.storageKey !== null &&
    input.expectedPathname !== null &&
    input.storageKey === input.expectedPathname &&
    isCanonicalCustomizationPathname(input.storageKey, input.assetId);
}
