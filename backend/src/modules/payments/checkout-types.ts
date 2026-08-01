export type CheckoutContact = {
  customerEmail: string;
  customerPhone: string | null;
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
};

export type CheckoutResult = {
  checkoutSessionId: string;
  orderId: string;
  paymentStatus: "checkout_started";
  url: string;
};
