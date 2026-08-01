import type Stripe from "stripe";
import { config } from "../../config/index.js";
import type { GuestCartContext } from "../cart/guest-session.js";
import { CheckoutProviderError } from "./checkout-errors.js";
import { CheckoutRepository } from "./checkout-repository.js";
import type { CheckoutContact, CheckoutResult } from "./checkout-types.js";

function sessionCustomerId(session: Stripe.Checkout.Session) {
  return typeof session.customer === "string" ? session.customer : null;
}

function sessionExpiresAt(session: Stripe.Checkout.Session) {
  return typeof session.expires_at === "number"
    ? new Date(session.expires_at * 1000)
    : null;
}

export class CheckoutService {
  constructor(
    private readonly repository: CheckoutRepository,
    private readonly stripe: Pick<Stripe, "checkout">,
  ) {}

  async startGuestCheckout(
    context: GuestCartContext,
    contact: CheckoutContact,
  ): Promise<CheckoutResult> {
    const prepared = await this.repository.prepareCheckout(context, contact);
    let session: Stripe.Checkout.Session;

    try {
      if (prepared.existingStripeSessionId) {
        session = await this.stripe.checkout.sessions.retrieve(
          prepared.existingStripeSessionId,
        );
      } else {
        session = await this.stripe.checkout.sessions.create(
          {
            cancel_url: config.payments.checkout.cancelUrl,
            client_reference_id: prepared.orderId,
            customer_email: prepared.customerEmail,
            line_items: prepared.lines.map((line) => ({
              price: line.stripePriceId,
              quantity: line.quantity
            })),
            metadata: { order_id: prepared.orderId },
            mode: "payment",
            payment_intent_data: {
              metadata: { order_id: prepared.orderId }
            },
            success_url: config.payments.checkout.successUrl
          },
          { idempotencyKey: `cart-checkout:${prepared.orderId}` },
        );
      }
    } catch {
      await this.repository.markProviderFailure(prepared.orderId);
      throw new CheckoutProviderError();
    }

    if (!session.url) {
      await this.repository.markProviderFailure(prepared.orderId);
      throw new CheckoutProviderError();
    }

    await this.repository.finalizeCheckout(prepared.orderId, {
      customerId: sessionCustomerId(session),
      expiresAt: sessionExpiresAt(session),
      sessionId: session.id
    });

    return {
      checkoutSessionId: session.id,
      orderId: prepared.orderId,
      paymentStatus: "checkout_started",
      url: session.url
    };
  }
}
