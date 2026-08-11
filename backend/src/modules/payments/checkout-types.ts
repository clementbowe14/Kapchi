import type { GuestCartContext } from "../cart/guest-session.js";

export type CheckoutCartOwner =
  | GuestCartContext
  | { authSubject: string };

export type PreferredContactMethod = "email" | "phone" | "sms";

export type CheckoutContact = {
  customerEmail: string;
  customerPhone: string | null;
  preferredContactMethod: PreferredContactMethod;
};

export type CheckoutReviewIssue = {
  cartItemId: string;
  message: string;
  status: "invalid" | "needs_reprice" | "unavailable";
};

export type CheckoutLine = {
  currency: string;
  orderItemId: string;
  quantity: number;
  stripePriceId: string;
};

export type PreparedCheckout = {
  customerEmail: string;
  existingStripeSessionId: string | null;
  lines: CheckoutLine[];
  orderId: string;
  publicOrderNumber: string;
};

export type CheckoutResult = {
  checkoutSessionId: string;
  orderId: string;
  paymentStatus: "checkout_started";
  publicOrderNumber: string;
  url: string;
};

export type CheckoutStatus = {
  orderId: string;
  paymentStatus: string;
  publicOrderNumber: string;
};
