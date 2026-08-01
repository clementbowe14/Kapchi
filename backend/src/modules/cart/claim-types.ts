import type { GuestCartDisplayItem, GuestCartValidationStatus } from "./guest-session.js";

export type VerifiedCartIdentity = {
  authSubject: string;
  avatarUrl: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
};

export type CartWarning = {
  cartItemId: string;
  message: string;
  status: Exclude<GuestCartValidationStatus, "valid">;
};

export type AuthenticatedCartView = {
  cartId?: string;
  items: GuestCartDisplayItem[];
  subtotalCents: number;
  warnings: CartWarning[];
};
