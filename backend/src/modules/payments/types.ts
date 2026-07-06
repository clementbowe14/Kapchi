export type PaymentStatus =
  | "unpaid"
  | "checkout_started"
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded";

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "in_production"
  | "ready_to_ship"
  | "shipped"
  | "completed"
  | "cancelled"
  | "refunded";

export type CheckoutOrderRow = {
  id: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  customer_email: string | null;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  discount_cents: number;
  total_cents: number;
  currency: string;
};

export type CheckoutOrderItemRow = {
  id: string;
  order_id: string;
  quantity: number;
  unit_amount_cents: number;
  total_amount_cents: number;
  currency: string;
  listing_snapshot: unknown;
};

export type CreateCheckoutSessionInput = {
  cancelUrl: string;
  orderId: string;
  successUrl: string;
};

export type CreateCheckoutSessionResult = {
  checkout_session_id: string;
  order_id: string;
  payment_status: "checkout_started";
  url: string;
};
