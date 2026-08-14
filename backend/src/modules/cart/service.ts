import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  hashSessionId,
  type GuestCartContext
} from "./guest-session.js";
import { CartIdempotencyConflictError, CartValidationError } from "./errors.js";
import { CartRepository } from "./repository.js";
import type { CartItemInput } from "./types.js";

function durableContext(context: GuestCartContext): GuestCartContext {
  return {
    cartId: context.cartId,
    sessionId: hashSessionId(context.sessionId)
  };
}

export function fingerprintCartItemInput(input: CartItemInput) {
  const canonical: CartItemInput = {
    fabricId: input.fabricId,
    fontOptionId: input.fontOptionId,
    imageAssetId: input.imageAssetId,
    line1: input.line1,
    line2: input.line2,
    listingCustomizationSetId: input.listingCustomizationSetId,
    listingId: input.listingId,
    listingPriceVariantId: input.listingPriceVariantId,
    quantity: input.quantity,
    trimOptionId: input.trimOptionId
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class CartService {
  private readonly repository: CartRepository;

  constructor(pool: Pick<Pool, "connect" | "query">) {
    this.repository = new CartRepository(pool);
  }

  async getGuestCart(context: GuestCartContext) {
    return this.repository.loadGuestView(durableContext(context));
  }

  async getAuthenticatedCart(authSubject: string) {
    return this.repository.loadAuthenticatedView(authSubject);
  }

  async getGuestCartSummary(context: GuestCartContext | null) {
    if (!context) {
      return { lineItemCount: 0, revision: 0, totalQuantity: 0 };
    }

    return this.repository.loadGuestSummary(durableContext(context));
  }

  async getAuthenticatedCartSummary(authSubject: string) {
    return this.repository.loadAuthenticatedSummary(authSubject);
  }

  async addGuestItem(
    context: GuestCartContext,
    input: CartItemInput,
    idempotencyKey: string,
  ) {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      throw new CartValidationError("A valid idempotency key is required.");
    }

    const requestFingerprint = fingerprintCartItemInput(input);
    const result = await this.repository.withTransaction(async (client) => {
      const cart = await this.repository.lockGuestCart(client, durableContext(context));
      const replay = await this.repository.loadAddIdempotency(
        client,
        cart.id,
        idempotencyKey,
      );

      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) {
          throw new CartIdempotencyConflictError();
        }

        return {
          ...(await this.repository.loadLockedGuestView(client, cart)),
          cartItemId: replay.cart_item_id
        };
      }

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
      await this.repository.recordAddIdempotency(
        client,
        cart.id,
        idempotencyKey,
        requestFingerprint,
        cartItemId,
      );

      return {
        ...(await this.repository.finishMutation(client, cart)),
        cartItemId
      };
    });

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

    return result;
  }
}
