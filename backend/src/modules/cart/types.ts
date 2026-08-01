import type { GuestCartDisplayItem } from "./guest-session.js";

export type CartItemInput = {
  fabricId: string | null;
  imageAssetId: string | null;
  line1: string;
  line2: string;
  listingCustomizationSetId: string;
  listingId: string;
  listingPriceVariantId: string;
  quantity: number;
};

export type GuestCartView = {
  cartId: string;
  expiresAt: Date | string;
  items: GuestCartDisplayItem[];
  subtotalCents: number;
};

export type CartMutationResult = GuestCartView & {
  cartItemId?: string;
};
