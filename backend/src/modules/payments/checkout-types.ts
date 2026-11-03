import type { GuestCartContext } from "../cart/guest-session.js";
import type {
  CustomerPolicySnapshot,
  PolicyAssertion
} from "../policies/policy-contract.js";

export type { CustomerPolicySnapshot, PolicyAssertion };

export type CheckoutCartOwner =
  | (GuestCartContext & { expectedRevision?: number })
  | {
      authSubject: string;
      cartId?: string;
      expectedRevision?: number;
    };

export type PreferredContactMethod = "email" | "phone" | "sms";

export type CheckoutContact = {
  customerEmail: string;
  customerPhone: string | null;
  preferredContactMethod: PreferredContactMethod;
};

export type CheckoutRequest = CheckoutContact & {
  cartId?: string;
  cartRevision?: number;
  policyAssertion: PolicyAssertion;
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
  cartId: string;
  cartRevision: number;
  cartStatus: "active" | "checkout_started";
  customerEmail: string;
  existingStripeSessionId: string | null;
  lines: CheckoutLine[];
  orderId: string;
  policySnapshot: CustomerPolicySnapshot;
  publicOrderNumber: string;
  reusedOrder: boolean;
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
  policySnapshot: CustomerPolicySnapshot | null;
};

export type CatalogUnavailableDisposition = {
  cartId: string | null;
  cartStatus: "abandoned" | "active" | null;
  orderRetired: boolean;
};
