import type Stripe from "stripe";
import { config } from "../../config/index.js";
import {
  CheckoutAlreadyCompleteError,
  CheckoutProviderError
} from "./checkout-errors.js";
import { CheckoutRepository } from "./checkout-repository.js";
import type {
  CheckoutContact,
  CheckoutCartOwner,
  CheckoutResult,
  PreparedCheckout
} from "./checkout-types.js";

function sessionCustomerId(session: Stripe.Checkout.Session) {
  return typeof session.customer === "string" ? session.customer : null;
}

function sessionExpiresAt(session: Stripe.Checkout.Session) {
  return typeof session.expires_at === "number"
    ? new Date(session.expires_at * 1000)
    : null;
}

function sessionDisposition(session: Stripe.Checkout.Session) {
  if (
    session.status === "complete" ||
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required"
  ) {
    return "complete" as const;
  }

  const expiresAt = sessionExpiresAt(session);
  if (
    session.status === "expired" ||
    !expiresAt ||
    expiresAt.getTime() <= Date.now()
  ) {
    return "expired" as const;
  }

  if (session.status === "open" && session.url) {
    return "reusable" as const;
  }

  return "unusable" as const;
}

export class CheckoutService {
  constructor(
    private readonly repository: CheckoutRepository,
    private readonly stripe: Pick<Stripe, "checkout">,
  ) {}

  async startCheckout(
    context: CheckoutCartOwner,
    contact: CheckoutContact,
  ): Promise<CheckoutResult> {
    let prepared = await this.repository.prepareCheckout(context, contact);
    let session = await this.requestProviderSession(prepared);
    let disposition = sessionDisposition(session);

    if (disposition === "complete") {
      if (!prepared.existingStripeSessionId) {
        await this.finalize(prepared.orderId, session);
      }
      throw new CheckoutAlreadyCompleteError();
    }

    if (disposition === "expired" || disposition === "unusable") {
      await this.repository.retireTerminalCheckout(
        prepared.orderId,
        {
          expiresAt: sessionExpiresAt(session),
          sessionId: session.id
        },
        disposition === "expired"
          ? "provider_session_expired"
          : "provider_session_unusable",
      );

      if (!prepared.existingStripeSessionId) {
        throw new CheckoutProviderError();
      }

      prepared = await this.repository.prepareCheckout(context, contact);
      session = await this.requestProviderSession(prepared);
      disposition = sessionDisposition(session);

      if (disposition === "complete") {
        await this.finalize(prepared.orderId, session);
        throw new CheckoutAlreadyCompleteError();
      }
      if (disposition !== "reusable") {
        await this.repository.retireTerminalCheckout(
          prepared.orderId,
          {
            expiresAt: sessionExpiresAt(session),
            sessionId: session.id
          },
          disposition === "expired"
            ? "provider_session_expired"
            : "provider_session_unusable",
        );
        throw new CheckoutProviderError();
      }
    }

    await this.finalize(prepared.orderId, session);

    return {
      checkoutSessionId: session.id,
      orderId: prepared.orderId,
      paymentStatus: "checkout_started",
      url: session.url!
    };
  }

  private async requestProviderSession(prepared: PreparedCheckout) {
    try {
      if (prepared.existingStripeSessionId) {
        return await this.stripe.checkout.sessions.retrieve(
          prepared.existingStripeSessionId,
        );
      }

      return await this.stripe.checkout.sessions.create(
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
    } catch {
      await this.repository.markProviderFailure(prepared.orderId);
      throw new CheckoutProviderError();
    }
  }

  private async finalize(orderId: string, session: Stripe.Checkout.Session) {
    await this.repository.finalizeCheckout(orderId, {
      customerId: sessionCustomerId(session),
      expiresAt: sessionExpiresAt(session),
      sessionId: session.id
    });
  }
}
