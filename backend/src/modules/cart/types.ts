import type { GuestCartDisplayItem } from "./guest-session.js";

export type CartItemInput = {
  fabricId: string | null;
  fontOptionId: string | null;
  imageAssetId: string | null;
  line1: string;
  line2: string;
  listingCustomizationSetId: string;
  listingId: string;
  listingPriceVariantId: string;
  priorityCode: string;
  quantity: number;
  trimOptionId: string | null;
};

export type GuestCartView = {
  cartId: string;
  expiresAt: Date | string;
  items: GuestCartDisplayItem[];
  lineItemCount: number;
  revision: number;
  subtotalCents: number;
  totalQuantity: number;
};

export type CartMutationResult = GuestCartView & {
  productionEstimateDiagnostics?: ProductionEstimateDiagnostics;
  cartItemId?: string;
};

export type ProductionEstimateDiagnostics = {
  customizationPackageId: string;
  listingId: string;
  outcome: "accepted" | "preserved" | "replayed";
  priorityCode: string;
  ruleId: string;
  ruleRevision: number;
};

export type CartSummary = {
  cartId?: string;
  lineItemCount: number;
  revision: number;
  totalQuantity: number;
};
