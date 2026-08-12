export const UNPAID_CUSTOMIZATION_POLICY_NOTICE =
  "Only customizations included in your selected package will be produced. Requests for unpaid additions will be rejected; update your package before checkout.";

export type ListingAvailability = {
  availableQuantity: number | null;
  label: string;
  status: "available" | "low_stock" | "unavailable" | "unknown";
};

export type ListingMedia = {
  alt: string | null;
  url: string;
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

export type GraduationStoleDetail = GraduationStoleSummary & {
  customizationPackages: Array<{
    capabilities: { image: boolean; text: boolean; trim: boolean };
    fonts: Array<{ id: string; name: string }>;
    id: string;
    kind: string;
    limits: {
      imageAllowedMimeTypes: string[];
      imageMaxBytes: number | null;
      imageMaxHeightPx: null;
      imageMaxWidthPx: null;
      imageMinHeightPx: null;
      imageMinWidthPx: null;
      maxChars: number | null;
      minChars: number;
    };
    name: string;
    priceDeltaCents: number;
    priceVariants: Array<{
      currency: string;
      fontOptionId: null;
      id: string;
      trimOptionId: string | null;
      unitAmountCents: number;
      variantKey: string;
    }>;
    requirements: { image: boolean; text: boolean; trim: boolean };
    trims: Array<{
      colorHex: string | null;
      id: string;
      name: string;
      priceDeltaCents: number;
      widthMm: null;
    }>;
  }>;
  description: string | null;
  fabrics: Array<{
    availability: ListingAvailability;
    colorHex: string | null;
    id: string;
    image: ListingMedia | null;
    materialDescription: string | null;
    name: string;
  }>;
  gallery: ListingMedia[];
  policyNotice: string;
};
