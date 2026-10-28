import { describe, expect, it } from "vitest";
import { AdminOrderError } from "./errors.js";
import { resolveAdminOrderTransition } from "./lifecycle.js";
import type {
  FulfillmentStatus,
  OrderStatus,
  PaymentStatus
} from "./types.js";

const paidAt = "2026-10-26T12:00:00.000Z";

describe("admin order lifecycle transitions", () => {
  it("starts production only from a paid queued order", () => {
    expect(resolveAdminOrderTransition("start_production", {
      fulfillmentStatus: "queued",
      orderStatus: "paid",
      paidAt,
      paymentStatus: "paid"
    })).toEqual({
      eventType: "order.production_started",
      fulfillmentStatus: "in_progress",
      orderStatus: "in_production"
    });
  });

  it("allows a partially refunded order to continue fulfillment", () => {
    expect(resolveAdminOrderTransition("mark_ready_to_ship", {
      fulfillmentStatus: "in_progress",
      orderStatus: "in_production",
      paidAt,
      paymentStatus: "partially_refunded"
    })).toMatchObject({
      fulfillmentStatus: "ready_to_ship",
      orderStatus: "ready_to_ship"
    });
  });

  it.each([
    ["start_production", "pending_payment", "unpaid", "not_started", null],
    ["start_production", "paid", "refunded", "queued", paidAt],
    ["start_production", "in_production", "paid", "in_progress", paidAt],
    ["mark_ready_to_ship", "paid", "paid", "queued", paidAt],
    ["mark_ready_to_ship", "cancelled", "paid", "cancelled", paidAt],
    ["mark_ready_to_ship", "in_production", "paid", "in_progress", null]
  ] as Array<[
    "start_production" | "mark_ready_to_ship",
    OrderStatus,
    PaymentStatus,
    FulfillmentStatus,
    string | null
  ]>)(
    "rejects %s from order=%s payment=%s fulfillment=%s paidAt=%s",
    (command, orderStatus, paymentStatus, fulfillmentStatus, paymentTimestamp) => {
      expect(() => resolveAdminOrderTransition(command, {
        fulfillmentStatus,
        orderStatus,
        paidAt: paymentTimestamp,
        paymentStatus
      })).toThrowError(AdminOrderError);
      try {
        resolveAdminOrderTransition(command, {
          fulfillmentStatus,
          orderStatus,
          paidAt: paymentTimestamp,
          paymentStatus
        });
      } catch (error) {
        expect(error).toMatchObject({
          code: "ORDER_TRANSITION_NOT_ALLOWED",
          statusCode: 409
        });
      }
    },
  );
});
