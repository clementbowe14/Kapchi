import type Stripe from "stripe";
import {
  CheckoutOrderNotFoundError,
  CheckoutOrderStateError,
  CheckoutProviderError
} from "./errors.js";
import { PaymentsRepository } from "./repository.js";
import { getStripeClient } from "./stripe.js";
import type {
  CheckoutOrderItemRow,
  CheckoutOrderRow,
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult
} from "./types.js";

const CHECKOUT_STARTED = "checkout_started";
const SUPPORTED_CURRENCY = "usd";

function extractListingName(snapshot: unknown) {
  if (
    snapshot !== null &&
    typeof snapshot === "object" &&
    "title" in snapshot &&
    typeof snapshot.title === "string" &&
    snapshot.title.trim().length > 0
  ) {
    return snapshot.title.trim();
  }

  return "Kapchi custom item";
}

function validateOrder(order: CheckoutOrderRow, items: CheckoutOrderItemRow[]) {
  if (order.status !== "pending_payment") {
    throw new CheckoutOrderStateError("Order must be pending payment.");
  }

  if (!["unpaid", "failed", CHECKOUT_STARTED].includes(order.payment_status)) {
    throw new CheckoutOrderStateError("Order is not payable.");
  }

  if (order.currency !== SUPPORTED_CURRENCY) {
    throw new CheckoutOrderStateError("Order currency is not supported.");
  }

  if (order.total_cents <= 0) {
    throw new CheckoutOrderStateError("Order total must be greater than zero.");
  }

  if (items.length === 0) {
    throw new CheckoutOrderStateError("Order must contain at least one item.");
  }

  const itemTotal = items.reduce((sum, item) => sum + item.total_amount_cents, 0);

  if (itemTotal !== order.subtotal_cents || itemTotal !== order.total_cents) {
    throw new CheckoutOrderStateError("Order item totals do not match the payable total.");
  }

  for (const item of items) {
    if (
      item.currency !== order.currency ||
      item.quantity <= 0 ||
      item.unit_amount_cents <= 0 ||
      item.total_amount_cents !== item.unit_amount_cents * item.quantity
    ) {
      throw new CheckoutOrderStateError("Order item totals are invalid.");
    }
  }
}

function buildLineItems(
  items: CheckoutOrderItemRow[],
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  return items.map((item) => ({
    price_data: {
      currency: item.currency,
      product_data: {
        name: extractListingName(item.listing_snapshot)
      },
      unit_amount: item.unit_amount_cents
    },
    quantity: item.quantity
  }));
}

function customerIdFromSession(session: Stripe.Checkout.Session) {
  return typeof session.customer === "string" ? session.customer : null;
}

function expiresAtFromSession(session: Stripe.Checkout.Session) {
  return typeof session.expires_at === "number"
    ? new Date(session.expires_at * 1000)
    : null;
}

export class CheckoutSessionService {
  constructor(
    private readonly repository: PaymentsRepository = new PaymentsRepository(),
    private readonly stripe: Pick<Stripe, "checkout"> = getStripeClient(),
  ) {}

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CreateCheckoutSessionResult> {
    return this.repository.withTransaction(async (client) => {
      const order = await this.repository.findOrderForCheckout(client, input.orderId);

      if (!order) {
        throw new CheckoutOrderNotFoundError();
      }

      const items = await this.repository.findOrderItemsForCheckout(client, order.id);
      validateOrder(order, items);

      let session: Stripe.Checkout.Session;

      try {
        session = await this.stripe.checkout.sessions.create({
          cancel_url: input.cancelUrl,
          client_reference_id: order.id,
          customer_email: order.customer_email ?? undefined,
          line_items: buildLineItems(items),
          metadata: {
            order_id: order.id
          },
          mode: "payment",
          payment_intent_data: {
            metadata: {
              order_id: order.id
            }
          },
          success_url: input.successUrl
        });
      } catch {
        throw new CheckoutProviderError();
      }

      if (!session.url) {
        throw new CheckoutProviderError();
      }

      await this.repository.markCheckoutStarted(client, {
        checkoutExpiresAt: expiresAtFromSession(session),
        orderId: order.id,
        stripeCheckoutSessionId: session.id,
        stripeCustomerId: customerIdFromSession(session)
      });

      return {
        checkout_session_id: session.id,
        order_id: order.id,
        payment_status: CHECKOUT_STARTED,
        url: session.url
      };
    });
  }
}
