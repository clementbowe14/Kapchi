import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  hashSessionId,
  type GuestCartContext
} from "./guest-session.js";
import { CartIdempotencyConflictError, CartValidationError } from "./errors.js";
import { CartRepository } from "./repository.js";
import type {
  CartItemInput,
  ProductionEstimateDiagnostics,
} from "./types.js";
import {
  parseProductionEstimateSnapshot,
  type ProductionEstimateSnapshot,
} from "../production-estimates.js";

function productionEstimateDiagnostics(
  input: CartItemInput,
  snapshot: ProductionEstimateSnapshot,
  outcome: ProductionEstimateDiagnostics["outcome"],
): ProductionEstimateDiagnostics {
  return {
    customizationPackageId: input.listingCustomizationSetId,
    listingId: input.listingId,
    outcome,
    priorityCode: snapshot.priorityCode,
    ruleId: snapshot.ruleId,
    ruleRevision: snapshot.ruleRevision,
  };
}

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
    priorityCode: input.priorityCode,
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

        const replaySnapshot = await this.repository.loadItemProductionEstimate(
          client,
          cart.id,
          replay.cart_item_id,
        );
        return {
          ...(await this.repository.loadLockedGuestView(client, cart)),
          cartItemId: replay.cart_item_id,
          ...(replaySnapshot
            ? {
                productionEstimateDiagnostics: productionEstimateDiagnostics(
                  input,
                  replaySnapshot,
                  "replayed",
                ),
              }
            : {}),
        };
      }

      await this.repository.assertLineCapacity(client, cart.id);
      const selection = await this.repository.validateSelection(client, cart, input);
      const cartItemId = await this.repository.insertItem(
        client,
        cart,
        input,
        selection.unit_amount_cents,
        selection.productionEstimateSnapshot,
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
        cartItemId,
        productionEstimateDiagnostics: productionEstimateDiagnostics(
          input,
          selection.productionEstimateSnapshot,
          "accepted",
        ),
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
      const currentProductionEstimate = parseProductionEstimateSnapshot(
        current.production_estimate_snapshot,
      );
      const preservedProductionEstimate =
        current.listing_id === input.listingId &&
        current.listing_customization_set_id === input.listingCustomizationSetId &&
        current.production_priority_code === input.priorityCode &&
        currentProductionEstimate?.priorityCode === current.production_priority_code
          ? currentProductionEstimate
          : undefined;
      const selection = await this.repository.validateSelection(
        client,
        cart,
        input,
        cartItemId,
        preservedProductionEstimate,
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
        selection.productionEstimateSnapshot,
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
        cartItemId,
        productionEstimateDiagnostics: productionEstimateDiagnostics(
          input,
          selection.productionEstimateSnapshot,
          preservedProductionEstimate ? "preserved" : "accepted",
        ),
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
