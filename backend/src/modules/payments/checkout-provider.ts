import type Stripe from "stripe";
import type { CheckoutLine } from "./checkout-types.js";

export type CheckoutProviderSession = {
  customerId: string | null;
  expiresAt: Date | null;
  id: string;
  paymentStatus: string;
  status: string | null;
  url: string | null;
};

export type CreateCheckoutProviderSession = {
  cancelUrl: string;
  customerEmail: string;
  lines: Pick<CheckoutLine, "quantity" | "stripePriceId">[];
  orderId: string;
  successUrl: string;
};

export interface CheckoutProvider {
  createSession(
    input: CreateCheckoutProviderSession,
    idempotencyKey: string,
  ): Promise<CheckoutProviderSession>;
  retrieveSession(sessionId: string): Promise<CheckoutProviderSession>;
}

export type StripePaymentsClient = Pick<Stripe, "checkout" | "webhooks">;

type StripeErrorDetails = {
  code?: unknown;
  param?: unknown;
};

const checkoutLineItemPriceParam =
  /^line_items(?:\[\d+\]|\.\d+)(?:\[price\]|\.price)$/;

export class CheckoutProviderPriceUnavailableError extends Error {
  readonly code = "resource_missing";

  constructor() {
    super("A checkout line item Price is unavailable.");
    this.name = "CheckoutProviderPriceUnavailableError";
  }
}

function isMissingCheckoutLineItemPrice(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const { code, param } = error as StripeErrorDetails;
  return (
    code === "resource_missing" &&
    typeof param === "string" &&
    checkoutLineItemPriceParam.test(param)
  );
}

function toProviderSession(
  session: Stripe.Checkout.Session,
): CheckoutProviderSession {
  return {
    customerId: typeof session.customer === "string" ? session.customer : null,
    expiresAt:
      typeof session.expires_at === "number"
        ? new Date(session.expires_at * 1000)
        : null,
    id: session.id,
    paymentStatus: session.payment_status,
    status: session.status,
    url: session.url
  };
}

export class StripeCheckoutProvider implements CheckoutProvider {
  constructor(private readonly stripe: Pick<Stripe, "checkout">) {}

  async createSession(
    input: CreateCheckoutProviderSession,
    idempotencyKey: string,
  ) {
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          cancel_url: input.cancelUrl,
          client_reference_id: input.orderId,
          customer_email: input.customerEmail,
          line_items: input.lines.map((line) => ({
            price: line.stripePriceId,
            quantity: line.quantity
          })),
          metadata: { order_id: input.orderId },
          mode: "payment",
          payment_intent_data: {
            metadata: { order_id: input.orderId }
          },
          success_url: input.successUrl
        },
        { idempotencyKey },
      );

      return toProviderSession(session);
    } catch (error) {
      if (isMissingCheckoutLineItemPrice(error)) {
        throw new CheckoutProviderPriceUnavailableError();
      }

      throw error;
    }
  }

  async retrieveSession(sessionId: string) {
    return toProviderSession(
      await this.stripe.checkout.sessions.retrieve(sessionId),
    );
  }
}
