import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  MAX_CART_SUBTOTAL_CENTS,
  MAX_GUEST_CART_ITEMS,
  serializeGuestCartItems,
  type GuestCartContext,
  type GuestCartDisplayItem,
  type GuestCartValidationStatus
} from "./guest-session.js";
import {
  CartConflictError,
  CartItemNotFoundError,
  CartNotFoundError,
  CartValidationError
} from "./errors.js";
import type { AuthenticatedCartView, CartWarning } from "./claim-types.js";
import type { CartItemInput, CartMutationResult, GuestCartView } from "./types.js";

type CartRow = QueryResultRow & {
  currency: string;
  expires_at: Date | string;
  id: string;
  subtotal_cents: number;
};

type SelectionRow = QueryResultRow & {
  currency: string;
  customization_enabled: boolean;
  listing_status: string;
  max_chars: number | null;
  min_chars: number;
  price_variant_active: boolean;
  requires_fabric: boolean;
  requires_image: boolean;
  requires_text: boolean;
  unit_amount_cents: number;
};

type FabricRow = QueryResultRow & {
  id: string;
  listing_fabric_active: boolean;
  quantity_on_hand: number;
  quantity_reserved: number;
  status: string;
};

type ExistingItemRow = QueryResultRow & {
  customization_asset_id: string | null;
  fabric_id: string | null;
  id: string;
  quantity: number;
};

type ReservationRow = QueryResultRow & {
  fabric_id: string;
  id: string;
  quantity: number;
};

type ProjectionRow = QueryResultRow & {
  cart_item_id: string;
  currency: string;
  customization_asset_id: string | null;
  customization_payload: unknown;
  customization_set_id: string;
  fabric_id: string | null;
  listing_id: string;
  listing_slug: string;
  quantity: number;
  title: string;
  unit_amount_cents: number;
  validation_status: GuestCartValidationStatus;
};

type Queryable = Pick<PoolClient, "query">;

function payloadLines(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { line1: "", line2: "" };
  }

  const value = payload as Record<string, unknown>;
  return {
    line1: typeof value.line1 === "string" ? value.line1 : "",
    line2: typeof value.line2 === "string" ? value.line2 : ""
  };
}

function mapProjection(rows: ProjectionRow[]): GuestCartDisplayItem[] {
  return rows.map((row) => {
    const lines = payloadLines(row.customization_payload);

    return {
      cartItemId: row.cart_item_id,
      listingId: row.listing_id,
      listingSlug: row.listing_slug,
      title: row.title,
      quantity: row.quantity,
      unitAmountCents: row.unit_amount_cents,
      currency: row.currency,
      fabricId: row.fabric_id,
      customizationSetId: row.customization_set_id,
      customizationSummary: {
        line1: lines.line1,
        line2: lines.line2,
        imageAssetId: row.customization_asset_id
      },
      validationStatus: row.validation_status
    };
  });
}

function validateText(input: CartItemInput, selection: SelectionRow) {
  const textLength = Array.from(`${input.line1}${input.line2}`).length;

  if (selection.requires_text && textLength < Math.max(1, selection.min_chars)) {
    throw new CartValidationError("This customization requires text.");
  }

  if (selection.max_chars !== null && textLength > selection.max_chars) {
    throw new CartValidationError(
      `Customization text must be ${selection.max_chars} characters or fewer.`,
    );
  }

  if (selection.requires_image && !input.imageAssetId) {
    throw new CartValidationError("This customization requires an image.");
  }
}

function authenticatedWarning(status: CartWarning["status"]) {
  return {
    invalid: "This cart item needs customization review.",
    needs_reprice: "This cart item needs price review.",
    unavailable: "This cart item is currently unavailable."
  }[status];
}

export class CartRepository {
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

  async lockGuestCart(client: Queryable, context: GuestCartContext) {
    const result = await client.query<CartRow>(
      `
        select id, currency, subtotal_cents, expires_at
        from carts
        where id = $1
          and guest_token_hash = $2
          and status = 'active'
          and expires_at > now()
        for update
      `,
      [context.cartId, context.sessionId],
    );

    const cart = result.rows[0];
    if (!cart) {
      throw new CartNotFoundError();
    }

    return cart;
  }

  async validateSelection(
    client: Queryable,
    cart: CartRow,
    input: CartItemInput,
    currentItemId?: string,
  ) {
    const result = await client.query<SelectionRow>(
      `
        select
          l.status as listing_status,
          l.requires_fabric,
          lcs.enabled as customization_enabled,
          lcs.min_chars,
          lcs.max_chars,
          cs.requires_text,
          cs.requires_image,
          lpv.active as price_variant_active,
          lpv.unit_amount_cents,
          lpv.currency
        from listings l
        join listing_customization_sets lcs
          on lcs.id = $2 and lcs.listing_id = l.id
        join customization_sets cs on cs.id = lcs.customization_set_id
        join listing_price_variants lpv
          on lpv.id = $3
          and lpv.listing_id = l.id
          and lpv.listing_customization_set_id = lcs.id
        where l.id = $1
        limit 1
      `,
      [input.listingId, input.listingCustomizationSetId, input.listingPriceVariantId],
    );
    const selection = result.rows[0];

    if (!selection) {
      throw new CartValidationError("The selected listing configuration is invalid.");
    }
    if (
      selection.listing_status !== "active" ||
      !selection.customization_enabled ||
      !selection.price_variant_active
    ) {
      throw new CartConflictError("The selected listing configuration is unavailable.");
    }
    if (selection.currency !== cart.currency) {
      throw new CartConflictError("The selected price uses a different currency.");
    }
    if (selection.requires_fabric && !input.fabricId) {
      throw new CartValidationError("This listing requires a fabric selection.");
    }

    validateText(input, selection);

    if (input.imageAssetId) {
      const asset = await client.query<{ id: string }>(
        `
          select a.id
          from assets a
          where a.id = $1
            and a.cart_id = $2
            and a.listing_id = $3
            and a.listing_customization_set_id = $4
            and a.context = 'customization_image'
            and a.visibility = 'private'
            and a.status in ('uploaded', 'attached')
            and not exists (
              select 1
              from cart_items ci
              where ci.customization_asset_id = a.id
                and ($5::uuid is null or ci.id <> $5::uuid)
          )
          limit 1
          for update of a
        `,
        [
          input.imageAssetId,
          cart.id,
          input.listingId,
          input.listingCustomizationSetId,
          currentItemId ?? null
        ],
      );

      if (!asset.rows[0]) {
        throw new CartValidationError("The selected customization image is unavailable.");
      }
    }

    if (input.fabricId) {
      const fabric = await client.query<FabricRow>(
        `
          select
            f.id,
            f.status,
            f.quantity_on_hand,
            f.quantity_reserved,
            lf.active as listing_fabric_active
          from fabrics f
          join listing_fabrics lf
            on lf.fabric_id = f.id and lf.listing_id = $2
          where f.id = $1
          for update of f
        `,
        [input.fabricId, input.listingId],
      );
      const fabricRow = fabric.rows[0];

      if (!fabricRow || fabricRow.status !== "active" || !fabricRow.listing_fabric_active) {
        throw new CartConflictError("The selected fabric is unavailable.");
      }
    }

    return selection;
  }

  async loadItem(client: Queryable, cartId: string, cartItemId: string) {
    const result = await client.query<ExistingItemRow>(
      `
        select id, fabric_id, quantity, customization_asset_id
        from cart_items
        where id = $1 and cart_id = $2
        for update
      `,
      [cartItemId, cartId],
    );
    const item = result.rows[0];

    if (!item) {
      throw new CartItemNotFoundError();
    }

    return item;
  }

  async loadReservation(client: Queryable, cartItemId: string) {
    const result = await client.query<ReservationRow>(
      `
        select id, fabric_id, quantity
        from fabric_reservations
        where cart_item_id = $1 and status = 'active'
        for update
      `,
      [cartItemId],
    );
    return result.rows[0] ?? null;
  }

  async assertLineCapacity(client: Queryable, cartId: string) {
    const result = await client.query<{ count: number | string }>(
      "select count(*)::integer as count from cart_items where cart_id = $1",
      [cartId],
    );

    if (Number(result.rows[0]?.count ?? 0) >= MAX_GUEST_CART_ITEMS) {
      throw new CartConflictError("The guest cart has reached its item limit.");
    }
  }

  async insertItem(
    client: Queryable,
    cart: CartRow,
    input: CartItemInput,
    unitAmountCents: number,
  ) {
    const result = await client.query<{ id: string }>(
      `
        insert into cart_items (
          cart_id,
          listing_id,
          listing_customization_set_id,
          listing_price_variant_id,
          fabric_id,
          quantity,
          unit_amount_cents,
          currency,
          customization_payload,
          customization_asset_id,
          validation_status
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'valid')
        returning id
      `,
      [
        cart.id,
        input.listingId,
        input.listingCustomizationSetId,
        input.listingPriceVariantId,
        input.fabricId,
        input.quantity,
        unitAmountCents,
        cart.currency,
        JSON.stringify({
          imageAssetId: input.imageAssetId,
          line1: input.line1,
          line2: input.line2
        }),
        input.imageAssetId
      ],
    );
    return result.rows[0].id;
  }

  async updateItem(
    client: Queryable,
    cart: CartRow,
    cartItemId: string,
    input: CartItemInput,
    unitAmountCents: number,
  ) {
    await client.query(
      `
        update cart_items
        set
          listing_id = $3,
          listing_customization_set_id = $4,
          listing_price_variant_id = $5,
          fabric_id = $6,
          quantity = $7,
          unit_amount_cents = $8,
          currency = $9,
          customization_payload = $10::jsonb,
          customization_asset_id = $11,
          validation_status = 'valid',
          validation_message = null
        where id = $1 and cart_id = $2
      `,
      [
        cartItemId,
        cart.id,
        input.listingId,
        input.listingCustomizationSetId,
        input.listingPriceVariantId,
        input.fabricId,
        input.quantity,
        unitAmountCents,
        cart.currency,
        JSON.stringify({
          imageAssetId: input.imageAssetId,
          line1: input.line1,
          line2: input.line2
        }),
        input.imageAssetId
      ],
    );
  }

  async deleteItem(client: Queryable, cartId: string, cartItemId: string) {
    await client.query("delete from cart_items where id = $1 and cart_id = $2", [
      cartItemId,
      cartId
    ]);
  }

  async reserveFabric(
    client: Queryable,
    cart: CartRow,
    cartItemId: string,
    fabricId: string,
    quantity: number,
    currentReservation: ReservationRow | null,
  ) {
    const reusableQuantity =
      currentReservation?.fabric_id === fabricId ? currentReservation.quantity : 0;
    const adjusted = await client.query<{ id: string }>(
      `
        update fabrics
        set quantity_reserved = quantity_reserved + $2
        where id = $1
          and quantity_reserved + $2 >= 0
          and quantity_reserved + $2 <= quantity_on_hand
        returning id
      `,
      [fabricId, quantity - reusableQuantity],
    );

    if (!adjusted.rows[0]) {
      throw new CartConflictError("The selected fabric does not have enough inventory.");
    }

    if (currentReservation?.fabric_id === fabricId) {
      await client.query(
        `
          update fabric_reservations
          set quantity = $2, expires_at = $3
          where id = $1
        `,
        [currentReservation.id, quantity, cart.expires_at],
      );
      return;
    }

    await client.query(
      `
        insert into fabric_reservations (
          fabric_id, cart_id, cart_item_id, quantity, status, expires_at
        ) values ($1, $2, $3, $4, 'active', $5)
      `,
      [fabricId, cart.id, cartItemId, quantity, cart.expires_at],
    );
  }

  async releaseReservation(client: Queryable, reservation: ReservationRow | null) {
    if (!reservation) {
      return;
    }

    await client.query(
      `
        update fabrics
        set quantity_reserved = greatest(0, quantity_reserved - $2)
        where id = $1
      `,
      [reservation.fabric_id, reservation.quantity],
    );
    await client.query(
      `
        update fabric_reservations
        set status = 'released', expires_at = now()
        where id = $1 and status = 'active'
      `,
      [reservation.id],
    );
  }

  async attachAsset(client: Queryable, cartId: string, input: CartItemInput) {
    if (!input.imageAssetId) {
      return;
    }

    const attached = await client.query<{ id: string }>(
      `
        update assets
        set status = 'attached'
        where id = $1
          and cart_id = $2
          and listing_id = $3
          and listing_customization_set_id = $4
          and context = 'customization_image'
          and visibility = 'private'
          and status in ('uploaded', 'attached')
        returning id
      `,
      [
        input.imageAssetId,
        cartId,
        input.listingId,
        input.listingCustomizationSetId
      ],
    );

    if (attached.rows.length !== 1) {
      throw new CartConflictError(
        "The selected customization image is no longer available.",
      );
    }
  }

  async releaseAsset(client: Queryable, cartId: string, assetId: string | null) {
    if (!assetId) {
      return;
    }

    await client.query(
      `
        update assets a
        set status = 'uploaded'
        where a.id = $1
          and a.cart_id = $2
          and a.status = 'attached'
          and not exists (
            select 1 from cart_items ci where ci.customization_asset_id = a.id
          )
      `,
      [assetId, cartId],
    );
  }

  async finishMutation(client: Queryable, cart: CartRow): Promise<CartMutationResult> {
    const total = await client.query<{ subtotal_cents: string }>(
      `
        select coalesce(
          sum(ci.quantity::bigint * ci.unit_amount_cents::bigint),
          0::bigint
        )::text as subtotal_cents
        from cart_items ci
        where ci.cart_id = $1
      `,
      [cart.id],
    );
    const subtotalCents = BigInt(total.rows[0]?.subtotal_cents ?? "0");

    if (
      subtotalCents < 0n ||
      subtotalCents > BigInt(MAX_CART_SUBTOTAL_CENTS)
    ) {
      throw new CartConflictError("Cart total exceeds the supported maximum.");
    }

    const subtotal = await client.query<{ subtotal_cents: number }>(
      `
        update carts
        set subtotal_cents = $2
        where id = $1
        returning subtotal_cents
      `,
      [cart.id, Number(subtotalCents)],
    );
    const items = await this.loadProjection(client, cart.id);

    serializeGuestCartItems(items);

    return {
      cartId: cart.id,
      expiresAt: cart.expires_at,
      items,
      subtotalCents: subtotal.rows[0]?.subtotal_cents ?? 0
    };
  }

  async loadProjection(client: Queryable, cartId: string) {
    const result = await client.query<ProjectionRow>(
      `
        select
          ci.id as cart_item_id,
          ci.listing_id,
          l.slug as listing_slug,
          l.title,
          ci.quantity,
          ci.unit_amount_cents,
          ci.currency,
          ci.fabric_id,
          ci.listing_customization_set_id as customization_set_id,
          ci.customization_payload,
          ci.customization_asset_id,
          ci.validation_status
        from cart_items ci
        join listings l on l.id = ci.listing_id
        where ci.cart_id = $1
        order by ci.created_at asc, ci.id asc
      `,
      [cartId],
    );
    return mapProjection(result.rows);
  }

  async loadGuestView(context: GuestCartContext): Promise<GuestCartView> {
    const cart = await this.loadGuestCartShell(context);

    return {
      cartId: cart.id,
      expiresAt: cart.expires_at,
      items: await this.loadProjection(this.pool, cart.id),
      subtotalCents: cart.subtotal_cents
    };
  }

  async loadGuestCartShell(context: GuestCartContext) {
    const cartResult = await this.pool.query<CartRow>(
      `
        select id, currency, subtotal_cents, expires_at
        from carts
        where id = $1
          and guest_token_hash = $2
          and status = 'active'
          and expires_at > now()
        limit 1
      `,
      [context.cartId, context.sessionId],
    );
    const cart = cartResult.rows[0];

    if (!cart) {
      throw new CartNotFoundError();
    }

    return cart;
  }

  async loadAuthenticatedView(authSubject: string): Promise<AuthenticatedCartView> {
    const cartResult = await this.pool.query<CartRow>(
      `
        select c.id, c.currency, c.subtotal_cents, c.expires_at
        from carts c
        left join users u on u.id = c.authenticated_user_id
        where c.status = 'active'
          and (
            c.user_id = $1
            or (u.auth_provider = 'clerk' and u.auth_subject = $1)
          )
        order by
          (u.auth_provider = 'clerk' and u.auth_subject = $1) desc,
          c.created_at asc,
          c.id asc
        limit 1
      `,
      [authSubject],
    );
    const cart = cartResult.rows[0];

    if (!cart) {
      return { items: [], subtotalCents: 0, warnings: [] };
    }

    const warnings = await this.pool.query<{
      id: string;
      validation_message: string | null;
      validation_status: CartWarning["status"];
    }>(
      `
        select id, validation_status, validation_message
        from cart_items
        where cart_id = $1 and validation_status <> 'valid'
        order by created_at asc, id asc
      `,
      [cart.id],
    );

    return {
      cartId: cart.id,
      items: await this.loadProjection(this.pool, cart.id),
      subtotalCents: cart.subtotal_cents,
      warnings: warnings.rows.map((row) => ({
        cartItemId: row.id,
        message:
          row.validation_message ?? authenticatedWarning(row.validation_status),
        status: row.validation_status
      }))
    };
  }
}
