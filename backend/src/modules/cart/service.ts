import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { RedisClientType } from "redis";
import {
  hashSessionId,
  readGuestCartItems,
  serializeGuestCartItems,
  writeGuestCartItems,
  type GuestCartContext
} from "./guest-session.js";
import { CartRepository } from "./repository.js";
import type { CartItemInput, CartMutationResult, GuestCartView } from "./types.js";

type SafeLogger = Pick<FastifyBaseLogger, "warn">;

function durableContext(context: GuestCartContext): GuestCartContext {
  return {
    cartId: context.cartId,
    sessionId: hashSessionId(context.sessionId)
  };
}

function remainingTtlSeconds(expiresAt: Date | string) {
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  return Math.floor((expiry - Date.now()) / 1000);
}

function safeCacheError(error: unknown) {
  return error instanceof Error ? { name: error.name } : { name: "UnknownError" };
}

export class CartService {
  private readonly repository: CartRepository;

  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly redis: RedisClientType,
    private readonly logger: SafeLogger,
  ) {
    this.repository = new CartRepository(pool);
  }

  async getGuestCart(context: GuestCartContext) {
    const cart = await this.repository.loadGuestCartShell(durableContext(context));

    try {
      const cached = await readGuestCartItems(this.redis, cart.id);

      if (cached.hit) {
        // Display projections may be stale until the next mutation. Checkout never trusts them.
        return {
          cartId: cart.id,
          expiresAt: cart.expires_at,
          items: cached.items,
          subtotalCents: cart.subtotal_cents
        };
      }
    } catch (error) {
      this.logger.warn(
        { cartId: cart.id, cacheError: safeCacheError(error) },
        "Guest cart projection read failed",
      );
    }

    const view = {
      cartId: cart.id,
      expiresAt: cart.expires_at,
      items: await this.repository.loadProjection(this.pool, cart.id),
      subtotalCents: cart.subtotal_cents
    };

    serializeGuestCartItems(view.items);
    await this.refreshAfterMutation(view);
    return view;
  }

  async getAuthenticatedCart(authSubject: string) {
    return this.repository.loadAuthenticatedView(authSubject);
  }

  async addGuestItem(context: GuestCartContext, input: CartItemInput) {
    const result = await this.repository.withTransaction(async (client) => {
      const cart = await this.repository.lockGuestCart(client, durableContext(context));
      await this.repository.assertLineCapacity(client, cart.id);
      const selection = await this.repository.validateSelection(client, cart, input);
      const cartItemId = await this.repository.insertItem(
        client,
        cart,
        input,
        selection.unit_amount_cents,
      );

      if (input.fabricId) {
        await this.repository.reserveFabric(
          client,
          cart,
          cartItemId,
          input.fabricId,
          input.quantity,
          null,
        );
      }
      await this.repository.attachAsset(client, cart.id, input);

      return {
        ...(await this.repository.finishMutation(client, cart)),
        cartItemId
      };
    });

    await this.refreshAfterMutation(result);
    return result;
  }

  async updateGuestItem(
    context: GuestCartContext,
    cartItemId: string,
    input: CartItemInput,
  ) {
    const result = await this.repository.withTransaction(async (client) => {
      const cart = await this.repository.lockGuestCart(client, durableContext(context));
      const current = await this.repository.loadItem(client, cart.id, cartItemId);
      const reservation = await this.repository.loadReservation(client, cartItemId);
      const selection = await this.repository.validateSelection(
        client,
        cart,
        input,
        cartItemId,
      );

      if (reservation && reservation.fabric_id !== input.fabricId) {
        await this.repository.releaseReservation(client, reservation);
      }
      if (input.fabricId) {
        await this.repository.reserveFabric(
          client,
          cart,
          cartItemId,
          input.fabricId,
          input.quantity,
          reservation?.fabric_id === input.fabricId ? reservation : null,
        );
      }

      await this.repository.updateItem(
        client,
        cart,
        cartItemId,
        input,
        selection.unit_amount_cents,
      );
      await this.repository.attachAsset(client, cart.id, input);

      if (current.customization_asset_id !== input.imageAssetId) {
        await this.repository.releaseAsset(
          client,
          cart.id,
          current.customization_asset_id,
        );
      }

      return {
        ...(await this.repository.finishMutation(client, cart)),
        cartItemId
      };
    });

    await this.refreshAfterMutation(result);
    return result;
  }

  async removeGuestItem(context: GuestCartContext, cartItemId: string) {
    const result = await this.repository.withTransaction(async (client) => {
      const cart = await this.repository.lockGuestCart(client, durableContext(context));
      const current = await this.repository.loadItem(client, cart.id, cartItemId);
      const reservation = await this.repository.loadReservation(client, cartItemId);

      await this.repository.releaseReservation(client, reservation);
      await this.repository.deleteItem(client, cart.id, cartItemId);
      await this.repository.releaseAsset(
        client,
        cart.id,
        current.customization_asset_id,
      );

      return this.repository.finishMutation(client, cart);
    });

    await this.refreshAfterMutation(result);
    return result;
  }

  private async refreshAfterMutation(result: CartMutationResult | GuestCartView) {
    try {
      await writeGuestCartItems(
        this.redis,
        result.cartId,
        result.items,
        remainingTtlSeconds(result.expiresAt),
      );
    } catch (error) {
      this.logger.warn(
        { cartId: result.cartId, cacheError: safeCacheError(error) },
        "Guest cart projection refresh failed",
      );
    }
  }

}
