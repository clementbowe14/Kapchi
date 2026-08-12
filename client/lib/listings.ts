export type ListingMedia = {
  alt: string | null;
  url: string;
};

export type ListingAvailability = {
  availableQuantity: number | null;
  label: string | null;
  status: "available" | "low_stock" | "unavailable" | "unknown";
};

export type GraduationStoleSummary = {
  availability: ListingAvailability;
  basePriceCents: number;
  currency: string;
  fromPriceCents: number;
  id: string;
  isCustomizable: boolean;
  listingType: "graduation_stole";
  primaryImage: ListingMedia | null;
  slug: string;
  subtitle: string | null;
  title: string;
};

export type FabricOption = {
  availability: ListingAvailability;
  colorHex: string | null;
  id: string;
  image: ListingMedia | null;
  materialDescription: string | null;
  name: string;
};

export type CustomizationCapabilities = {
  image: boolean;
  text: boolean;
  trim: boolean;
};

export type CustomizationLimits = {
  imageAllowedMimeTypes: string[];
  imageMaxBytes: number | null;
  imageMaxHeightPx: number | null;
  imageMaxWidthPx: number | null;
  imageMinHeightPx: number | null;
  imageMinWidthPx: number | null;
  maxChars: number | null;
  minChars: number | null;
};

export type FontOption = {
  id: string;
  name: string;
};

export type TrimOption = {
  colorHex: string | null;
  id: string;
  name: string;
  priceDeltaCents: number;
  widthMm: number | null;
};

export type ListingPriceVariant = {
  currency: string;
  fontOptionId: string | null;
  id: string;
  trimOptionId: string | null;
  unitAmountCents: number;
  variantKey: string | null;
};

export type CustomizationPackage = {
  capabilities: CustomizationCapabilities;
  fonts: FontOption[];
  id: string;
  kind: string;
  limits: CustomizationLimits;
  name: string;
  priceDeltaCents: number;
  priceVariants: ListingPriceVariant[];
  requirements: CustomizationCapabilities;
  trims: TrimOption[];
};

export type GraduationStoleDetail = GraduationStoleSummary & {
  customizationPackages: CustomizationPackage[];
  description: string | null;
  fabrics: FabricOption[];
  gallery: ListingMedia[];
  policyNotice: string;
};

export type GraduationStoleCollection = {
  items: GraduationStoleSummary[];
  requestId: string | null;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ListingContractError(`${path} must be an object.`);
  }

  return value as UnknownRecord;
}

function string(value: unknown, path: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ListingContractError(`${path} must be a non-empty string.`);
  }

  return value.trim();
}

function nullableString(value: unknown, path: string) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ListingContractError(`${path} must be a string or null.`);
  }

  return value.trim() || null;
}

function boolean(value: unknown, path: string) {
  if (typeof value !== "boolean") {
    throw new ListingContractError(`${path} must be a boolean.`);
  }

  return value;
}

function integer(value: unknown, path: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ListingContractError(
      `${path} must be an integer greater than or equal to ${minimum}.`,
    );
  }

  return value as number;
}

function nullableInteger(value: unknown, path: string, minimum = 0) {
  if (value === null || value === undefined) {
    return null;
  }

  return integer(value, path, minimum);
}

function stringArray(value: unknown, path: string) {
  if (value === null || value === undefined) {
    return [];
  }

  return array(value, path).map((item, index) =>
    string(item, `${path}[${index}]`),
  );
}

function array(value: unknown, path: string) {
  if (!Array.isArray(value)) {
    throw new ListingContractError(`${path} must be an array.`);
  }

  return value;
}

function parseMedia(value: unknown, path: string): ListingMedia | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim() ? { alt: null, url: value.trim() } : null;
  }

  const media = record(value, path);
  const rawUrl = media.url ?? media.imageUrl;

  if (rawUrl === null || rawUrl === undefined || rawUrl === "") {
    return null;
  }

  return {
    alt: nullableString(media.alt ?? media.altText, `${path}.alt`),
    url: string(rawUrl, `${path}.url`),
  };
}

function normalizeAvailabilityStatus(value: string) {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");

  if (normalized === "in_stock") {
    return "available" as const;
  }

  if (normalized === "out_of_stock") {
    return "unavailable" as const;
  }

  if (
    normalized === "available" ||
    normalized === "low_stock" ||
    normalized === "unavailable" ||
    normalized === "unknown"
  ) {
    return normalized;
  }

  return "unknown" as const;
}

function parseAvailability(
  value: unknown,
  path: string,
): ListingAvailability {
  if (typeof value === "string") {
    return {
      availableQuantity: null,
      label: null,
      status: normalizeAvailabilityStatus(string(value, path)),
    };
  }

  const availability = record(value, path);
  const rawStatus = availability.status ?? availability.code;

  return {
    availableQuantity: nullableInteger(
      availability.availableQuantity,
      `${path}.availableQuantity`,
    ),
    label: nullableString(availability.label, `${path}.label`),
    status: normalizeAvailabilityStatus(string(rawStatus, `${path}.status`)),
  };
}

function parseSummary(value: unknown, path: string): GraduationStoleSummary {
  const listing = record(value, path);
  const listingType = string(listing.listingType, `${path}.listingType`);

  if (listingType !== "graduation_stole") {
    throw new ListingContractError(
      `${path}.listingType must be graduation_stole.`,
    );
  }

  return {
    availability: parseAvailability(listing.availability, `${path}.availability`),
    basePriceCents: integer(listing.basePriceCents, `${path}.basePriceCents`),
    currency: string(listing.currency, `${path}.currency`).toUpperCase(),
    fromPriceCents: integer(listing.fromPriceCents, `${path}.fromPriceCents`),
    id: string(listing.id, `${path}.id`),
    isCustomizable: boolean(listing.isCustomizable, `${path}.isCustomizable`),
    listingType,
    primaryImage: parseMedia(listing.primaryImage, `${path}.primaryImage`),
    slug: string(listing.slug, `${path}.slug`),
    subtitle: nullableString(listing.subtitle, `${path}.subtitle`),
    title: string(listing.title, `${path}.title`),
  };
}

function parseCapabilities(value: unknown, path: string) {
  const capabilities = record(value, path);

  return {
    image: boolean(capabilities.image, `${path}.image`),
    text: boolean(capabilities.text, `${path}.text`),
    trim: boolean(capabilities.trim, `${path}.trim`),
  };
}

function parseLimits(value: unknown, path: string): CustomizationLimits {
  if (value === null || value === undefined) {
    return {
      imageAllowedMimeTypes: [],
      imageMaxBytes: null,
      imageMaxHeightPx: null,
      imageMaxWidthPx: null,
      imageMinHeightPx: null,
      imageMinWidthPx: null,
      maxChars: null,
      minChars: null,
    };
  }

  const limits = record(value, path);

  return {
    imageAllowedMimeTypes: stringArray(
      limits.imageAllowedMimeTypes ?? limits.allowedMimeTypes,
      `${path}.imageAllowedMimeTypes`,
    ),
    imageMaxBytes: nullableInteger(
      limits.imageMaxBytes ?? limits.image_max_bytes,
      `${path}.imageMaxBytes`,
      1,
    ),
    imageMaxHeightPx: nullableInteger(
      limits.imageMaxHeightPx ?? limits.maxImageHeightPx,
      `${path}.imageMaxHeightPx`,
      1,
    ),
    imageMaxWidthPx: nullableInteger(
      limits.imageMaxWidthPx ?? limits.maxImageWidthPx,
      `${path}.imageMaxWidthPx`,
      1,
    ),
    imageMinHeightPx: nullableInteger(
      limits.imageMinHeightPx ?? limits.minImageHeightPx,
      `${path}.imageMinHeightPx`,
      1,
    ),
    imageMinWidthPx: nullableInteger(
      limits.imageMinWidthPx ?? limits.minImageWidthPx,
      `${path}.imageMinWidthPx`,
      1,
    ),
    maxChars: nullableInteger(
      limits.maxChars ??
        limits.maxTextCharacters ??
        limits.max_chars ??
        limits.defaultMaxChars ??
        limits.default_max_chars,
      `${path}.maxChars`,
      1,
    ),
    minChars: nullableInteger(
      limits.minChars ?? limits.minTextCharacters ?? limits.min_chars,
      `${path}.minChars`,
    ),
  };
}

function parseFont(value: unknown, path: string): FontOption {
  const font = record(value, path);
  return {
    id: string(font.id, `${path}.id`),
    name: string(font.name ?? font.label, `${path}.name`),
  };
}

function parseTrim(value: unknown, path: string): TrimOption {
  const trim = record(value, path);
  return {
    colorHex: nullableString(trim.colorHex, `${path}.colorHex`),
    id: string(trim.id, `${path}.id`),
    name: string(trim.name, `${path}.name`),
    priceDeltaCents: integer(
      trim.priceDeltaCents ?? 0,
      `${path}.priceDeltaCents`,
    ),
    widthMm: nullableInteger(trim.widthMm, `${path}.widthMm`, 1),
  };
}

function parsePriceVariant(
  value: unknown,
  path: string,
): ListingPriceVariant {
  const variant = record(value, path);
  return {
    currency: string(variant.currency, `${path}.currency`).toUpperCase(),
    fontOptionId: nullableString(variant.fontOptionId, `${path}.fontOptionId`),
    id: string(variant.id, `${path}.id`),
    trimOptionId: nullableString(variant.trimOptionId, `${path}.trimOptionId`),
    unitAmountCents: integer(
      variant.unitAmountCents,
      `${path}.unitAmountCents`,
    ),
    variantKey: nullableString(variant.variantKey, `${path}.variantKey`),
  };
}

function parsePackage(value: unknown, path: string): CustomizationPackage {
  const customizationPackage = record(value, path);

  return {
    capabilities: parseCapabilities(
      customizationPackage.capabilities,
      `${path}.capabilities`,
    ),
    fonts: array(customizationPackage.fonts, `${path}.fonts`).map((font, index) =>
      parseFont(font, `${path}.fonts[${index}]`),
    ),
    id: string(customizationPackage.id, `${path}.id`),
    kind: string(customizationPackage.kind, `${path}.kind`),
    limits: parseLimits(customizationPackage.limits, `${path}.limits`),
    name: string(customizationPackage.name, `${path}.name`),
    priceDeltaCents: integer(
      customizationPackage.priceDeltaCents,
      `${path}.priceDeltaCents`,
    ),
    priceVariants: array(
      customizationPackage.priceVariants,
      `${path}.priceVariants`,
    ).map((variant, index) =>
      parsePriceVariant(variant, `${path}.priceVariants[${index}]`),
    ),
    requirements: parseCapabilities(
      customizationPackage.requirements,
      `${path}.requirements`,
    ),
    trims: array(customizationPackage.trims, `${path}.trims`).map((trim, index) =>
      parseTrim(trim, `${path}.trims[${index}]`),
    ),
  };
}

export class ListingContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListingContractError";
  }
}

export class ListingApiError extends Error {
  readonly requestId: string | null;
  readonly status: number;

  constructor(message: string, status: number, requestId: string | null) {
    super(message);
    this.name = "ListingApiError";
    this.requestId = requestId;
    this.status = status;
  }
}

export function parseGraduationStoleCollection(
  value: unknown,
): GraduationStoleCollection {
  const response = record(value, "response");

  return {
    items: array(response.items, "response.items").map((item, index) =>
      parseSummary(item, `response.items[${index}]`),
    ),
    requestId: nullableString(response.requestId, "response.requestId"),
  };
}

export function parseGraduationStoleDetail(
  value: unknown,
): GraduationStoleDetail {
  const listing = record(value, "listing");
  const summary = parseSummary(listing, "listing");

  return {
    ...summary,
    customizationPackages: array(
      listing.customizationPackages,
      "listing.customizationPackages",
    ).map((customizationPackage, index) =>
      parsePackage(
        customizationPackage,
        `listing.customizationPackages[${index}]`,
      ),
    ),
    description: nullableString(listing.description, "listing.description"),
    fabrics: array(listing.fabrics, "listing.fabrics").map((fabric, index) => {
      const parsedFabric = record(fabric, `listing.fabrics[${index}]`);
      const path = `listing.fabrics[${index}]`;

      return {
        availability: parseAvailability(
          parsedFabric.availability,
          `${path}.availability`,
        ),
        colorHex: nullableString(parsedFabric.colorHex, `${path}.colorHex`),
        id: string(parsedFabric.id, `${path}.id`),
        image: parseMedia(parsedFabric.image, `${path}.image`),
        materialDescription: nullableString(
          parsedFabric.materialDescription ?? parsedFabric.material,
          `${path}.materialDescription`,
        ),
        name: string(parsedFabric.name, `${path}.name`),
      };
    }),
    gallery: array(listing.gallery, "listing.gallery")
      .map((media, index) => parseMedia(media, `listing.gallery[${index}]`))
      .filter((media): media is ListingMedia => media !== null),
    policyNotice: string(listing.policyNotice, "listing.policyNotice"),
  };
}

export type RetryDelay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type ListingFetchOptions = {
  baseDelayMs?: number;
  delay?: RetryDelay;
  fetcher?: typeof fetch;
  maxAttempts?: number;
  maxDelayMs?: number;
  now?: () => number;
  random?: () => number;
  signal?: AbortSignal;
};

const defaultDelay: RetryDelay = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(
  value: string | null,
  now: () => number,
): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - now());
}

function retryDelayMilliseconds({
  attempt,
  baseDelayMs,
  maxDelayMs,
  now,
  random,
  response,
}: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  now: () => number;
  random: () => number;
  response?: Response;
}) {
  const retryAfter = response
    ? retryAfterMilliseconds(response.headers.get("retry-after"), now)
    : null;

  if (retryAfter !== null) {
    return Math.min(maxDelayMs, retryAfter);
  }

  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.min(maxDelayMs, Math.round(exponential * jitter));
}

export async function fetchListingGet(
  url: string,
  options: ListingFetchOptions = {},
) {
  const {
    baseDelayMs = 150,
    delay = defaultDelay,
    fetcher = fetch,
    maxAttempts = 3,
    maxDelayMs = 2_000,
    now = Date.now,
    random = Math.random,
    signal,
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new RangeError("maxAttempts must be between 1 and 3.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;

    try {
      response = await fetcher(url, {
        cache: "no-store",
        headers: { accept: "application/json" },
        method: "GET",
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted || attempt === maxAttempts) {
        throw error;
      }

      await delay(
        retryDelayMilliseconds({
          attempt,
          baseDelayMs,
          maxDelayMs,
          now,
          random,
        }),
        signal,
      );
      continue;
    }

    if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
      return response;
    }

    await delay(
      retryDelayMilliseconds({
        attempt,
        baseDelayMs,
        maxDelayMs,
        now,
        random,
        response,
      }),
      signal,
    );
  }

  throw new Error("Listing request exhausted without a response.");
}

function listingsApiUrl(path: string) {
  const baseUrl = (
    process.env.BACKEND_INTERNAL_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    `http://localhost:${process.env.BACKEND_PORT ?? "4000"}`
  ).replace(/\/$/, "");

  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function responseBody(response: Response) {
  const body = (await response.json().catch(() => null)) as UnknownRecord | null;

  if (!response.ok) {
    throw new ListingApiError(
      typeof body?.message === "string"
        ? body.message
        : "The graduation stole catalog could not be loaded.",
      response.status,
      typeof body?.requestId === "string"
        ? body.requestId
        : response.headers.get("x-request-id"),
    );
  }

  return body;
}

export async function getGraduationStoleListings(
  options: ListingFetchOptions = {},
) {
  const response = await fetchListingGet(
    listingsApiUrl("/listings?type=graduation_stole"),
    options,
  );
  return parseGraduationStoleCollection(await responseBody(response));
}

export async function getGraduationStoleBySlug(
  slug: string,
  options: ListingFetchOptions = {},
) {
  const response = await fetchListingGet(
    listingsApiUrl(`/listings/${encodeURIComponent(slug)}`),
    options,
  );
  return parseGraduationStoleDetail(await responseBody(response));
}
