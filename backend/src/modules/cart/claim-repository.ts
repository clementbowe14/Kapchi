import type { Pool, PoolClient, QueryResultRow } from "pg";
import { MAX_CART_SUBTOTAL_CENTS, hashSessionId, type GuestCartContext } from "./guest-session.js";
import { CartRepository } from "./repository.js";
import { CartClaimConflictError, CartClaimForbiddenError } from "./claim-errors.js";
import type {
  AuthenticatedCartView,
  CartWarning,
  VerifiedCartIdentity
} from "./claim-types.js";

type Queryable = Pick<PoolClient, "query">;

type IdentityRow = QueryResultRow & {
  disabled_at: Date | null;
  id: string;
};

type CustomerRow = QueryResultRow & { id: string };

type CartRow = QueryResultRow & {
  authenticated_user_id: string | null;
  currency: string;
  expires_at: Date | string | null;
  id: string;
  subtotal_cents: number;
  user_id: string | null;
};

type MergeLineRow = QueryResultRow & {
  cart_id: string;
  customization_asset_id: string | null;
  customization_payload: unknown;
  currency: string;
  fabric_id: string | null;
  id: string;
  listing_customization_set_id: string;
  listing_id: string;
  listing_price_variant_id: string;
  quantity: number;
  unit_amount_cents: number;
  validation_message: string | null;
  validation_status: "valid" | "invalid" | "needs_reprice" | "unavailable";
};

type ReservationRow = QueryResultRow & {
  cart_id: string;
  expires_at: Date | string;
  fabric_id: string;
  id: string;
  quantity: number;
  unexpired: boolean;
};

type IdentityIds = {
  contactId: string | null;
  customerId: string;
  userId: string;
};

function canonicalLines(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { line1: "", line2: "" };
  }

  const value = payload as Record<string, unknown>;
  return {
    line1: typeof value.line1 === "string" ? value.line1 : "",
    line2: typeof value.line2 === "string" ? value.line2 : ""
  };
}

function linesMatch(left: MergeLineRow, right: MergeLineRow) {
  const leftLines = canonicalLines(left.customization_payload);
  const rightLines = canonicalLines(right.customization_payload);

  return (
    left.listing_id === right.listing_id &&
    left.listing_customization_set_id === right.listing_customization_set_id &&
    left.listing_price_variant_id === right.listing_price_variant_id &&
    left.fabric_id === right.fabric_id &&
    leftLines.line1 === rightLines.line1 &&
    leftLines.line2 === rightLines.line2 &&
    left.customization_asset_id === right.customization_asset_id
  );
}

function statusRank(status: MergeLineRow["validation_status"]) {
  return {
    valid: 0,
    needs_reprice: 1,
    unavailable: 2,
    invalid: 3
  }[status];
}

function strongestStatus(left: MergeLineRow, right: MergeLineRow) {
  return statusRank(left.validation_status) >= statusRank(right.validation_status)
    ? left
    : right;
}

function genericWarning(status: CartWarning["status"]) {
  return {
    invalid: "This cart item needs customization review.",
    needs_reprice: "This cart item needs price review.",
    unavailable: "This cart item is currently unavailable."
  }[status];
}

export class CartClaimRepository {
  private readonly cartRepository: CartRepository;

  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {
    this.cartRepository = new CartRepository(pool);
  }

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

  async claim(
    identity: VerifiedCartIdentity,
    guestContext: GuestCartContext | null,
  ): Promise<AuthenticatedCartView> {
    return this.withTransaction(async (client) => {
      const ids = await this.upsertIdentity(client, identity);
      const accountCart = await this.lockAccountCart(
        client,
        ids.userId,
        identity.authSubject,
      );
      const guestCart = guestContext
        ? await this.lockGuestCart(client, guestContext)
        : null;

      if (!guestCart) {
        if (!accountCart) {
          return { items: [], subtotalCents: 0, warnings: [] };
        }

        await this.assignAuthenticatedOwner(client, accountCart.id, identity, ids);
        return this.loadView(client, accountCart.id);
      }

      if (!accountCart || accountCart.id === guestCart.id) {
        const guestLines = await this.loadLines(client, guestCart.id);
        await this.moveReferencedAssets(
          client,
          guestLines,
          guestCart.id,
          guestCart.id,
          identity,
          ids.userId,
        );
        await this.assignAuthenticatedOwner(client, guestCart.id, identity, ids);
        await this.refreshSubtotal(client, guestCart.id);
        return this.loadView(client, guestCart.id);
      }

      if (accountCart.currency !== guestCart.currency) {
        throw new CartClaimConflictError(
          "The guest cart uses a different currency and cannot be merged safely.",
        );
      }

      await this.assignAuthenticatedOwner(client, accountCart.id, identity, ids);
      await this.mergeCartLines(
        client,
        guestCart,
        accountCart,
        identity,
        ids.userId,
      );
      const abandoned = await client.query<{ id: string }>(
        `
          update carts
          set
            status = 'abandoned',
            user_id = $2,
            authenticated_user_id = $3,
            customer_id = $4,
            customer_contact_id = $5,
            guest_token_hash = null,
            expires_at = null
          where id = $1 and status = 'active'
          returning id
        `,
        [
          guestCart.id,
          identity.authSubject,
          ids.userId,
          ids.customerId,
          ids.contactId
        ],
      );
      if (abandoned.rows.length !== 1) {
        throw new CartClaimConflictError("The guest cart changed during merge.");
      }
      await this.refreshSubtotal(client, accountCart.id);
      return this.loadView(client, accountCart.id);
    });
  }

  private async upsertIdentity(client: Queryable, identity: VerifiedCartIdentity) {
    const userResult = await client.query<IdentityRow>(
      `
        insert into users (
          auth_provider, auth_subject, email, phone, display_name, avatar_url, last_seen_at
        ) values ('clerk', $1, $2, $3, $4, $5, now())
        on conflict (auth_provider, auth_subject) do update set
          email = coalesce(excluded.email, users.email),
          phone = coalesce(excluded.phone, users.phone),
          display_name = coalesce(excluded.display_name, users.display_name),
          avatar_url = coalesce(excluded.avatar_url, users.avatar_url),
          last_seen_at = now()
        returning id, disabled_at
      `,
      [
        identity.authSubject,
        identity.email,
        identity.phone,
        identity.displayName,
        identity.avatarUrl
      ],
    );
    const user = userResult.rows[0];

    if (!user || user.disabled_at) {
      throw new CartClaimForbiddenError();
    }

    await client.query("select id from users where id = $1 for update", [user.id]);

    const customerResult = await client.query<CustomerRow>(
      `
        insert into customers (
          user_id, email, phone, full_name, preferred_contact_method
        ) values (
          $1, $2, $3, $4,
          case when $2::text is not null then 'email'::preferred_contact_method
               when $3::text is not null then 'phone'::preferred_contact_method
               else null end
        )
        on conflict (user_id) where user_id is not null do update set
          email = coalesce(excluded.email, customers.email),
          phone = coalesce(excluded.phone, customers.phone),
          full_name = coalesce(excluded.full_name, customers.full_name),
          preferred_contact_method = coalesce(
            excluded.preferred_contact_method,
            customers.preferred_contact_method
          )
        returning id
      `,
      [user.id, identity.email, identity.phone, identity.displayName],
    );
    const customer = customerResult.rows[0];

    if (!customer) {
      throw new CartClaimConflictError("Unable to resolve the account customer.");
    }

    let contactId: string | null = null;
    if (identity.email || identity.phone) {
      const contact = await client.query<CustomerRow>(
        `
          insert into customer_contacts (
            customer_id,
            label,
            contact_name,
            email,
            phone,
            preferred_contact_method,
            is_primary
          ) values (
            $1, 'Primary', $2, $3, $4,
            case when $3::text is not null then 'email'::preferred_contact_method
                 else 'phone'::preferred_contact_method end,
            true
          )
          on conflict (customer_id) where is_primary do update set
            contact_name = coalesce(excluded.contact_name, customer_contacts.contact_name),
            email = coalesce(excluded.email, customer_contacts.email),
            phone = coalesce(excluded.phone, customer_contacts.phone),
            preferred_contact_method = excluded.preferred_contact_method
          returning id
        `,
        [customer.id, identity.displayName, identity.email, identity.phone],
      );
      contactId = contact.rows[0]?.id ?? null;
    } else {
      const contact = await client.query<CustomerRow>(
        `
          select id
          from customer_contacts
          where customer_id = $1 and is_primary
          limit 1
          for update
        `,
        [customer.id],
      );
      contactId = contact.rows[0]?.id ?? null;
    }

    return {
      contactId,
      customerId: customer.id,
      userId: user.id
    } satisfies IdentityIds;
  }

  private async lockAccountCart(
    client: Queryable,
    authenticatedUserId: string,
    authSubject: string,
  ) {
    const result = await client.query<CartRow>(
      `
        select
          id, user_id, authenticated_user_id, currency, subtotal_cents, expires_at
        from carts
        where status = 'active'
          and (authenticated_user_id = $1 or user_id = $2)
        order by
          (authenticated_user_id = $1) desc,
          created_at asc,
          id asc
        for update
      `,
      [authenticatedUserId, authSubject],
    );

    if (result.rows.length > 1) {
      throw new CartClaimConflictError(
        "Multiple active account carts must be resolved before claiming another cart.",
      );
    }

    return result.rows[0] ?? null;
  }

  private async lockGuestCart(client: Queryable, context: GuestCartContext) {
    const result = await client.query<CartRow>(
      `
        select
          id, user_id, authenticated_user_id, currency, subtotal_cents, expires_at
        from carts
        where id = $1
          and guest_token_hash = $2
          and status = 'active'
          and expires_at > now()
        for update
      `,
      [context.cartId, hashSessionId(context.sessionId)],
    );
    return result.rows[0] ?? null;
  }

  private async assignAuthenticatedOwner(
    client: Queryable,
    cartId: string,
    identity: VerifiedCartIdentity,
    ids: IdentityIds,
  ) {
    const result = await client.query<{ id: string }>(
      `
        update carts
        set
          user_id = $2,
          authenticated_user_id = $3,
          customer_id = $4,
          customer_contact_id = $5,
          guest_token_hash = null,
          expires_at = null
        where id = $1 and status = 'active'
        returning id
      `,
      [cartId, identity.authSubject, ids.userId, ids.customerId, ids.contactId],
    );

    if (result.rows.length !== 1) {
      throw new CartClaimConflictError("The cart owner changed during claim.");
    }
  }

  private async loadLines(client: Queryable, cartId: string) {
    const result = await client.query<MergeLineRow>(
      `
        select
          id,
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
          validation_status,
          validation_message
        from cart_items
        where cart_id = $1
        order by created_at asc, id asc
        for update
      `,
      [cartId],
    );
    return result.rows;
  }

  private async mergeCartLines(
    client: Queryable,
    sourceCart: CartRow,
    destinationCart: CartRow,
    identity: VerifiedCartIdentity,
    authenticatedUserId: string,
  ) {
    const destinationLines = await this.loadLines(client, destinationCart.id);
    const sourceLines = await this.loadLines(client, sourceCart.id);
    const movedAssets = new Set<string>();

    for (const source of sourceLines) {
      const sourceReservation = await this.loadReservation(client, source.id);
      const hasValidSourceReservation = this.reservationMatches(
        source,
        sourceReservation,
      );

      if (!hasValidSourceReservation) {
        await this.releaseInvalidReservation(
          client,
          sourceReservation,
          sourceCart.id,
          destinationCart.id,
        );
        source.validation_status = "unavailable";
        source.validation_message = "The selected fabric reservation is unavailable.";
      }

      const destination = destinationLines.find((line) => linesMatch(line, source));
      const combinedQuantity = (destination?.quantity ?? 0) + source.quantity;
      const destinationReservation = destination
        ? await this.loadReservation(client, destination.id)
        : null;
      const canCombineReservation =
        hasValidSourceReservation &&
        (destination
          ? this.reservationMatches(destination, destinationReservation)
          : false);

      if (destination && combinedQuantity <= 999 && canCombineReservation) {
        const strongest = strongestStatus(destination, source);
        const combinedItem = await client.query<{ id: string }>(
          `
            update cart_items
            set
              quantity = $3,
              validation_status = $4,
              validation_message = $5
            where id = $1 and cart_id = $2
            returning id
          `,
          [
            destination.id,
            destinationCart.id,
            combinedQuantity,
            strongest.validation_status,
            strongest.validation_message
          ],
        );
        if (combinedItem.rows.length !== 1) {
          throw new CartClaimConflictError("A destination cart item changed.");
        }

        if (sourceReservation && destinationReservation) {
          await this.combineReservations(
            client,
            sourceReservation,
            destinationReservation,
            combinedQuantity,
          );
        }
        await this.moveAsset(
          client,
          source,
          sourceCart.id,
          destinationCart.id,
          identity,
          authenticatedUserId,
          movedAssets,
        );
        const deletedItem = await client.query<{ id: string }>(
          `
            delete from cart_items
            where id = $1 and cart_id = $2
            returning id
          `,
          [source.id, sourceCart.id],
        );
        if (deletedItem.rows.length !== 1) {
          throw new CartClaimConflictError("A source cart item changed.");
        }
        destination.quantity = combinedQuantity;
        destination.validation_status = strongest.validation_status;
        destination.validation_message = strongest.validation_message;
        continue;
      }

      if (sourceReservation && hasValidSourceReservation) {
        const movedReservation = await client.query<{ id: string }>(
          `
            update fabric_reservations
            set cart_id = $2
            where id = $1 and cart_id = $3 and status = 'active'
            returning id
          `,
          [sourceReservation.id, destinationCart.id, sourceCart.id],
        );
        if (movedReservation.rows.length !== 1) {
          throw new CartClaimConflictError(
            "A fabric reservation changed during cart claim.",
          );
        }
      }

      const movedLine = await client.query<{ id: string }>(
        `
          update cart_items
          set
            cart_id = $2,
            validation_status = $3,
            validation_message = $4
          where id = $1 and cart_id = $5
          returning id
        `,
        [
          source.id,
          destinationCart.id,
          source.validation_status,
          source.validation_message,
          sourceCart.id
        ],
      );
      if (movedLine.rows.length !== 1) {
        throw new CartClaimConflictError("A cart item changed during cart claim.");
      }
      await this.moveAsset(
        client,
        source,
        sourceCart.id,
        destinationCart.id,
        identity,
        authenticatedUserId,
        movedAssets,
      );
      source.cart_id = destinationCart.id;
      destinationLines.push(source);
    }
  }

  private async loadReservation(client: Queryable, cartItemId: string) {
    const result = await client.query<ReservationRow>(
      `
        select
          id,
          cart_id,
          fabric_id,
          quantity,
          expires_at,
          expires_at > now() as unexpired
        from fabric_reservations
        where cart_item_id = $1 and status = 'active'
        for update
      `,
      [cartItemId],
    );
    return result.rows[0] ?? null;
  }

  private reservationMatches(
    line: MergeLineRow,
    reservation: ReservationRow | null,
  ) {
    return line.fabric_id
      ? Boolean(
          reservation &&
            reservation.cart_id === line.cart_id &&
            reservation.fabric_id === line.fabric_id &&
            reservation.quantity === line.quantity &&
            reservation.unexpired,
        )
      : reservation === null;
  }

  private async releaseInvalidReservation(
    client: Queryable,
    reservation: ReservationRow | null,
    sourceCartId: string,
    destinationCartId: string,
  ) {
    if (!reservation) {
      return;
    }

    const adjusted = await client.query<{ id: string }>(
      `
        update fabrics
        set quantity_reserved = quantity_reserved - $2
        where id = $1 and quantity_reserved >= $2
        returning id
      `,
      [reservation.fabric_id, reservation.quantity],
    );
    if (adjusted.rows.length !== 1) {
      throw new CartClaimConflictError(
        "Fabric inventory changed during cart claim.",
      );
    }

    const released = await client.query<{ id: string }>(
      `
        update fabric_reservations
        set status = 'released', expires_at = now(), cart_id = $2
        where id = $1 and cart_id = $3 and status = 'active'
        returning id
      `,
      [reservation.id, destinationCartId, sourceCartId],
    );
    if (released.rows.length !== 1) {
      throw new CartClaimConflictError(
        "A fabric reservation changed during cart claim.",
      );
    }
  }

  private async combineReservations(
    client: Queryable,
    source: ReservationRow,
    destination: ReservationRow,
    quantity: number,
  ) {
    const combined = await client.query<{ id: string }>(
      `
        update fabric_reservations
        set quantity = $2, expires_at = greatest(expires_at, $3)
        where id = $1 and status = 'active'
        returning id
      `,
      [destination.id, quantity, source.expires_at],
    );
    if (combined.rows.length !== 1) {
      throw new CartClaimConflictError(
        "A destination fabric reservation changed during cart claim.",
      );
    }
    const released = await client.query<{ id: string }>(
      `
        update fabric_reservations
        set status = 'released', expires_at = now()
        where id = $1 and status = 'active'
        returning id
      `,
      [source.id],
    );
    if (released.rows.length !== 1) {
      throw new CartClaimConflictError(
        "A source fabric reservation changed during cart claim.",
      );
    }
  }

  private async moveReferencedAssets(
    client: Queryable,
    lines: MergeLineRow[],
    sourceCartId: string,
    destinationCartId: string,
    identity: VerifiedCartIdentity,
    authenticatedUserId: string,
  ) {
    const movedAssets = new Set<string>();
    for (const line of lines) {
      await this.moveAsset(
        client,
        line,
        sourceCartId,
        destinationCartId,
        identity,
        authenticatedUserId,
        movedAssets,
      );
    }
  }

  private async moveAsset(
    client: Queryable,
    line: MergeLineRow,
    sourceCartId: string,
    destinationCartId: string,
    identity: VerifiedCartIdentity,
    authenticatedUserId: string,
    movedAssets: Set<string>,
  ) {
    const assetId = line.customization_asset_id;
    if (!assetId || movedAssets.has(assetId)) {
      return;
    }

    const result = await client.query<{ id: string }>(
      `
        update assets
        set
          cart_id = $2,
          authenticated_user_id = $3,
          created_by_auth_subject = $4
        where id = $1
          and cart_id = $5
          and context = 'customization_image'
          and visibility = 'private'
          and status in ('uploaded', 'attached')
          and (authenticated_user_id is null or authenticated_user_id = $3)
          and (created_by_auth_subject is null or created_by_auth_subject = $4)
        returning id
      `,
      [
        assetId,
        destinationCartId,
        authenticatedUserId,
        identity.authSubject,
        sourceCartId
      ],
    );
    if (result.rows.length !== 1) {
      throw new CartClaimConflictError("A customization asset changed during claim.");
    }
    movedAssets.add(assetId);
  }

  private async refreshSubtotal(client: Queryable, cartId: string) {
    const totalResult = await client.query<{ subtotal_cents: string }>(
      `
        select coalesce(
          sum(quantity::bigint * unit_amount_cents::bigint),
          0::bigint
        )::text as subtotal_cents
        from cart_items
        where cart_id = $1
      `,
      [cartId],
    );
    const subtotalCents = BigInt(totalResult.rows[0]?.subtotal_cents ?? "0");

    if (subtotalCents < 0n || subtotalCents > BigInt(MAX_CART_SUBTOTAL_CENTS)) {
      throw new CartClaimConflictError(
        "The merged cart total exceeds the supported maximum.",
      );
    }

    const updated = await client.query<{ id: string }>(
      `
        update carts
        set subtotal_cents = $2
        where id = $1 and status = 'active'
        returning id
      `,
      [cartId, Number(subtotalCents)],
    );
    if (updated.rows.length !== 1) {
      throw new CartClaimConflictError("The cart changed during subtotal update.");
    }
  }

  private async loadView(
    client: Queryable,
    cartId: string,
  ): Promise<AuthenticatedCartView> {
    const cartResult = await client.query<{ subtotal_cents: number }>(
      "select subtotal_cents from carts where id = $1 and status = 'active'",
      [cartId],
    );
    const warningResult = await client.query<{
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
      [cartId],
    );

    return {
      cartId,
      items: await this.cartRepository.loadProjection(client, cartId),
      subtotalCents: cartResult.rows[0]?.subtotal_cents ?? 0,
      warnings: warningResult.rows.map((row) => ({
        cartItemId: row.id,
        message: row.validation_message ?? genericWarning(row.validation_status),
        status: row.validation_status
      }))
    };
  }
}
