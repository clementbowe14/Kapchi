import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { hashSessionId, type GuestCartContext } from "../cart/guest-session.js";
import { CheckoutCartNotFoundError, CheckoutNeedsReviewError } from "./checkout-errors.js";
import type { CheckoutContact, CheckoutLine, PreparedCheckout } from "./checkout-types.js";

type CartRow = QueryResultRow & {
  authenticated_user_id: string | null;
  currency: string;
  customer_contact_id: string | null;
  customer_id: string | null;
  id: string;
  status: "active" | "checkout_started";
  subtotal_cents: number;
  user_id: string | null;
};

type CartItemRow = QueryResultRow & {
  asset_cart_id: string | null;
  asset_context: string | null;
  asset_listing_customization_set_id: string | null;
  asset_listing_id: string | null;
  asset_status: string | null;
  asset_visibility: string | null;
  cart_id: string;
  cart_item_id: string;
  currency: string;
  current_currency: string;
  current_unit_amount_cents: number;
  customization_asset_id: string | null;
  customization_enabled: boolean;
  customization_listing_id: string;
  customization_payload: unknown;
  fabric_color_name: string | null;
  fabric_id: string | null;
  fabric_listing_active: boolean | null;
  fabric_material: string | null;
  fabric_name: string | null;
  fabric_quantity_on_hand: number | null;
  fabric_quantity_reserved: number | null;
  fabric_reservation_quantity: number | null;
  fabric_reservation_fabric_id: string | null;
  fabric_sku: string | null;
  fabric_status: string | null;
  listing_customization_set_id: string;
  listing_id: string;
  listing_price_variant_id: string;
  listing_requires_fabric: boolean;
  listing_slug: string;
  listing_status: string;
  listing_title: string;
  max_chars: number | null;
  min_chars: number;
  quantity: number;
  requires_image: boolean;
  requires_text: boolean;
  stripe_price_id: string;
  stripe_product_id: string;
  unit_amount_cents: number;
  variant_active: boolean;
  variant_customization_set_id: string;
  variant_listing_id: string;
};

type ExistingOrderRow = QueryResultRow & {
  customer_email: string | null;
  id: string;
  stripe_checkout_session_id: string | null;
};

type Queryable = Pick<PoolClient, "query">;

function customizationLines(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { line1: "", line2: "" };
  }

  const value = payload as Record<string, unknown>;
  return {
    line1: typeof value.line1 === "string" ? value.line1 : "",
    line2: typeof value.line2 === "string" ? value.line2 : ""
  };
}

function parseV1Customization(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const value = payload as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(["imageAssetId", "line1", "line2"]) ||
    typeof value.line1 !== "string" ||
    typeof value.line2 !== "string" ||
    !(value.imageAssetId === null || typeof value.imageAssetId === "string")
  ) {
    return null;
  }

  return {
    imageAssetId: value.imageAssetId,
    line1: value.line1,
    line2: value.line2
  };
}

function validationFailure(item: CartItemRow) {
  if (
    item.unit_amount_cents !== item.current_unit_amount_cents ||
    item.currency !== item.current_currency
  ) {
    return {
      message: "The cart price changed and must be reviewed.",
      status: "needs_reprice" as const
    };
  }

  if (
    item.listing_status !== "active" ||
    !item.customization_enabled ||
    !item.variant_active ||
    item.customization_listing_id !== item.listing_id ||
    item.variant_listing_id !== item.listing_id ||
    item.variant_customization_set_id !== item.listing_customization_set_id
  ) {
    return {
      message: "A cart item is no longer available.",
      status: "unavailable" as const
    };
  }

  const customization = parseV1Customization(item.customization_payload);
  const textLength = customization
    ? Array.from(`${customization.line1}${customization.line2}`).length
    : 0;
  if (
    !customization ||
    customization.imageAssetId !== item.customization_asset_id ||
    (item.requires_text && textLength < Math.max(1, item.min_chars)) ||
    (item.max_chars !== null && textLength > item.max_chars)
  ) {
    return {
      message: "A cart customization is no longer valid.",
      status: "invalid" as const
    };
  }

  const hasInvalidAsset = Boolean(
    item.customization_asset_id &&
      (item.asset_cart_id === null ||
        item.asset_cart_id !== item.cart_id ||
        item.asset_listing_id !== item.listing_id ||
        item.asset_listing_customization_set_id !==
          item.listing_customization_set_id ||
        item.asset_context !== "customization_image" ||
        item.asset_visibility !== "private" ||
        item.asset_status !== "attached"),
  );

  if (
    (item.requires_image && !item.customization_asset_id) ||
    hasInvalidAsset
  ) {
    return {
      message: "A customization image is unavailable.",
      status: "invalid" as const
    };
  }

  if (item.listing_requires_fabric && !item.fabric_id) {
    return {
      message: "A required fabric selection is missing.",
      status: "invalid" as const
    };
  }

  if (item.fabric_id) {
    const available =
      (item.fabric_quantity_on_hand ?? 0) -
      (item.fabric_quantity_reserved ?? 0) +
      (item.fabric_reservation_quantity ?? 0);

    if (
      item.fabric_status !== "active" ||
      !item.fabric_listing_active ||
      item.fabric_reservation_fabric_id !== item.fabric_id ||
      item.fabric_reservation_quantity !== item.quantity ||
      available < item.quantity
    ) {
      return {
        message: "The selected fabric is unavailable.",
        status: "unavailable" as const
      };
    }
  }

  return null;
}

function orderNumber(orderId: string) {
  return `KAP-${orderId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

export class CheckoutRepository {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareCheckout(
    context: GuestCartContext,
    contact: CheckoutContact,
  ): Promise<PreparedCheckout> {
    const prepared = await this.withTransaction(async (client) => {
      const cartResult = await client.query<CartRow>(
        `
          select
            id,
            user_id,
            authenticated_user_id,
            customer_id,
            customer_contact_id,
            status,
            currency,
            subtotal_cents
          from carts
          where id = $1
            and guest_token_hash = $2
            and (
              (status = 'active' and expires_at > now())
              or status = 'checkout_started'
            )
          for update
        `,
        [context.cartId, hashSessionId(context.sessionId)],
      );
      const cart = cartResult.rows[0];

      if (!cart) {
        throw new CheckoutCartNotFoundError();
      }

      const existing = await this.findExistingOrder(client, cart.id);
      if (existing) {
        return {
          customerEmail: existing.customer_email ?? contact.customerEmail,
          existingStripeSessionId: existing.stripe_checkout_session_id,
          lines: await this.loadOrderLines(client, existing.id),
          orderId: existing.id
        };
      }

      if (cart.status !== "active") {
        throw new CheckoutNeedsReviewError("The cart checkout state cannot be recovered.");
      }

      const items = await this.loadCartItems(client, cart.id);
      if (items.length === 0) {
        throw new CheckoutNeedsReviewError("The cart is empty.");
      }

      const failures = items
        .map((item) => ({ failure: validationFailure(item), item }))
        .filter((entry) => entry.failure !== null);

      if (failures.length > 0) {
        for (const { failure, item } of failures) {
          await client.query(
            `
              update cart_items
              set validation_status = $2, validation_message = $3
              where id = $1 and cart_id = $4
            `,
            [item.cart_item_id, failure?.status, failure?.message, cart.id],
          );
        }

        return {
          reviewMessage: failures.some(
            ({ failure }) => failure?.status === "needs_reprice",
          )
            ? "The cart price changed and must be reviewed."
            : "The cart contains items that must be reviewed."
        };
      }

      const subtotal = items.reduce(
        (sum, item) => sum + item.unit_amount_cents * item.quantity,
        0,
      );
      if (subtotal !== cart.subtotal_cents || subtotal <= 0) {
        return { reviewMessage: "The cart total must be reviewed." };
      }

      const orderId = randomUUID();
      await client.query(
        `
          insert into orders (
            id,
            public_order_number,
            user_id,
            authenticated_user_id,
            customer_id,
            customer_contact_id,
            cart_id,
            status,
            payment_status,
            fulfillment_status,
            customer_email,
            customer_phone,
            preferred_contact_method,
            subtotal_cents,
            total_cents,
            currency
          ) values (
            $1, $2, $3, $4, $5, $6, $7,
            'pending_payment', 'unpaid', 'not_started',
            $8, $9, 'email', $10, $10, $11
          )
        `,
        [
          orderId,
          orderNumber(orderId),
          cart.user_id,
          cart.authenticated_user_id,
          cart.customer_id,
          cart.customer_contact_id,
          cart.id,
          contact.customerEmail,
          contact.customerPhone,
          subtotal,
          cart.currency
        ],
      );

      const lines: CheckoutLine[] = [];
      for (const item of items) {
        const orderItemId = randomUUID();
        const customization = customizationLines(item.customization_payload);
        const fabricSnapshot = item.fabric_id
          ? {
              colorName: item.fabric_color_name,
              id: item.fabric_id,
              material: item.fabric_material,
              name: item.fabric_name,
              sku: item.fabric_sku
            }
          : null;

        await client.query(
          `
            insert into order_items (
              id,
              order_id,
              listing_id,
              listing_price_variant_id,
              fabric_id,
              quantity,
              unit_amount_cents,
              total_amount_cents,
              currency,
              stripe_product_id,
              stripe_price_id,
              listing_snapshot,
              fabric_snapshot,
              customization_snapshot,
              customization_asset_id
            ) values (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15
            )
          `,
          [
            orderItemId,
            orderId,
            item.listing_id,
            item.listing_price_variant_id,
            item.fabric_id,
            item.quantity,
            item.unit_amount_cents,
            item.unit_amount_cents * item.quantity,
            item.currency,
            item.stripe_product_id,
            item.stripe_price_id,
            JSON.stringify({
              id: item.listing_id,
              slug: item.listing_slug,
              title: item.listing_title
            }),
            JSON.stringify(fabricSnapshot),
            JSON.stringify({
              imageAssetId: item.customization_asset_id,
              line1: customization.line1,
              line2: customization.line2
            }),
            item.customization_asset_id
          ],
        );

        await client.query(
          `
            update fabric_reservations
            set order_id = $2, order_item_id = $3
            where cart_item_id = $1 and status = 'active'
          `,
          [item.cart_item_id, orderId, orderItemId],
        );

        lines.push({
          currency: item.currency,
          orderItemId,
          quantity: item.quantity,
          stripePriceId: item.stripe_price_id
        });
      }

      await client.query(
        "update carts set status = 'checkout_started' where id = $1",
        [cart.id],
      );
      await client.query(
        `
          insert into order_events (
            order_id, actor_type, event_type, to_value, metadata
          ) values ($1, 'customer', 'checkout.materialized', 'checkout_started', $2::jsonb)
        `,
        [orderId, JSON.stringify({ cartId: cart.id })],
      );

      return {
        customerEmail: contact.customerEmail,
        existingStripeSessionId: null,
        lines,
        orderId
      };
    });

    if (
      "reviewMessage" in prepared &&
      typeof prepared.reviewMessage === "string"
    ) {
      throw new CheckoutNeedsReviewError(prepared.reviewMessage);
    }

    return prepared;
  }

  async finalizeCheckout(
    orderId: string,
    session: {
      customerId: string | null;
      expiresAt: Date | null;
      sessionId: string;
    },
  ) {
    await this.withTransaction(async (client) => {
      const result = await client.query<{ stripe_checkout_session_id: string | null }>(
        `
          select stripe_checkout_session_id
          from orders
          where id = $1 and status = 'pending_payment'
          for update
        `,
        [orderId],
      );
      const order = result.rows[0];

      if (!order) {
        throw new CheckoutCartNotFoundError();
      }
      if (
        order.stripe_checkout_session_id &&
        order.stripe_checkout_session_id !== session.sessionId
      ) {
        throw new CheckoutNeedsReviewError("Checkout already uses another provider session.");
      }

      await client.query(
        `
          update orders
          set
            payment_status = 'checkout_started',
            stripe_checkout_session_id = $2,
            stripe_customer_id = $3,
            checkout_expires_at = $4
          where id = $1
        `,
        [orderId, session.sessionId, session.customerId, session.expiresAt],
      );
    });
  }

  async markProviderFailure(orderId: string) {
    await this.pool.query(
      `
        update orders
        set payment_status = 'failed'
        where id = $1 and payment_status in ('unpaid', 'failed')
      `,
      [orderId],
    );
  }

  private async findExistingOrder(client: Queryable, cartId: string) {
    const result = await client.query<ExistingOrderRow>(
      `
        select id, customer_email, stripe_checkout_session_id
        from orders
        where cart_id = $1
          and status = 'pending_payment'
          and payment_status in ('unpaid', 'checkout_started', 'failed')
        order by created_at desc, id desc
        limit 1
        for update
      `,
      [cartId],
    );
    return result.rows[0] ?? null;
  }

  private async loadOrderLines(client: Queryable, orderId: string) {
    const result = await client.query<{
      currency: string;
      id: string;
      quantity: number;
      stripe_price_id: string;
    }>(
      `
        select id, quantity, currency, stripe_price_id
        from order_items
        where order_id = $1
        order by created_at asc, id asc
      `,
      [orderId],
    );
    return result.rows.map((row) => ({
      currency: row.currency,
      orderItemId: row.id,
      quantity: row.quantity,
      stripePriceId: row.stripe_price_id
    }));
  }

  private async loadCartItems(client: Queryable, cartId: string) {
    const result = await client.query<CartItemRow>(
      `
        select
          ci.id as cart_item_id,
          ci.cart_id,
          ci.listing_id,
          ci.listing_customization_set_id,
          ci.listing_price_variant_id,
          ci.fabric_id,
          ci.quantity,
          ci.unit_amount_cents,
          ci.currency,
          ci.customization_payload,
          ci.customization_asset_id,
          l.slug as listing_slug,
          l.title as listing_title,
          l.status as listing_status,
          l.requires_fabric as listing_requires_fabric,
          lcs.enabled as customization_enabled,
          lcs.listing_id as customization_listing_id,
          lcs.min_chars,
          lcs.max_chars,
          cs.requires_text,
          cs.requires_image,
          lpv.active as variant_active,
          lpv.listing_id as variant_listing_id,
          lpv.listing_customization_set_id as variant_customization_set_id,
          lpv.unit_amount_cents as current_unit_amount_cents,
          lpv.currency as current_currency,
          lpv.stripe_product_id,
          lpv.stripe_price_id,
          f.name as fabric_name,
          f.sku as fabric_sku,
          f.color_name as fabric_color_name,
          f.material as fabric_material,
          f.status as fabric_status,
          f.quantity_on_hand as fabric_quantity_on_hand,
          f.quantity_reserved as fabric_quantity_reserved,
          lf.active as fabric_listing_active,
          fr.quantity as fabric_reservation_quantity,
          fr.fabric_id as fabric_reservation_fabric_id,
          a.cart_id as asset_cart_id,
          a.listing_id as asset_listing_id,
          a.listing_customization_set_id as asset_listing_customization_set_id,
          a.context as asset_context,
          a.status as asset_status,
          a.visibility as asset_visibility
        from cart_items ci
        join listings l on l.id = ci.listing_id
        join listing_customization_sets lcs
          on lcs.id = ci.listing_customization_set_id
        join customization_sets cs on cs.id = lcs.customization_set_id
        join listing_price_variants lpv on lpv.id = ci.listing_price_variant_id
        left join fabrics f on f.id = ci.fabric_id
        left join listing_fabrics lf
          on lf.listing_id = ci.listing_id and lf.fabric_id = ci.fabric_id
        left join fabric_reservations fr
          on fr.cart_item_id = ci.id and fr.status = 'active'
        left join assets a on a.id = ci.customization_asset_id
        where ci.cart_id = $1
        order by ci.created_at asc, ci.id asc
      `,
      [cartId],
    );
    return result.rows;
  }
}
