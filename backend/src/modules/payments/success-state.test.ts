import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeFabricInventory,
  handleCheckoutSessionCompleted,
  handlePaymentIntentSucceeded
} from "./success-state.js";

const orderId = "2db9f8e1-d0f0-4b39-b521-1ab59db038c8";

function createOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    status: "pending_payment",
    payment_status: "checkout_started",
    fulfillment_status: "not_started",
    paid_at: null,
    stripe_checkout_session_id: "cs_test_123",
    stripe_payment_intent_id: null,
    ...overrides
  };
}

function createClient() {
  return {
    query: vi.fn()
  };
}

function mockSuccessfulTransaction(
  client: ReturnType<typeof createClient>,
  order = createOrderRow(),
) {
  client.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [order] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

describe("successful Stripe payment state handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks an order paid from checkout.session.completed", async () => {
    const client = createClient();
    mockSuccessfulTransaction(client);

    const result = await handleCheckoutSessionCompleted(client, {
      id: "cs_test_123",
      metadata: {
        order_id: orderId
      },
      payment_intent: "pi_test_123"
    });

    expect(result).toEqual({
      outcome: "updated",
      orderId
    });
    expect(client.query.mock.calls[1][1]).toEqual([
      orderId,
      "cs_test_123",
      "pi_test_123"
    ]);
    expect(client.query.mock.calls[2][1]).toEqual([orderId]);
    expect(client.query.mock.calls[3][1]).toEqual([orderId]);
    expect(client.query.mock.calls[4][1]).toEqual([orderId, "pi_test_123"]);
    expect(client.query.mock.calls[4][0]).toContain(
      "fulfillment_queued_at = case",
    );
    expect(client.query.mock.calls[5][1]).toEqual([
      orderId,
      "pi_test_123",
      "checkout_started",
      {
        checkoutSessionId: "cs_test_123",
        eventType: "checkout.session.completed",
        paymentIntentId: "pi_test_123"
      }
    ]);
    expect(client.query.mock.calls[6][0]).toBe("commit");
  });

  it("marks an order paid from payment_intent.succeeded", async () => {
    const client = createClient();
    mockSuccessfulTransaction(client);

    const result = await handlePaymentIntentSucceeded(client, {
      id: "pi_test_456",
      metadata: {
        order_id: orderId
      }
    });

    expect(result).toEqual({
      outcome: "updated",
      orderId
    });
    expect(client.query.mock.calls[1][1]).toEqual([orderId, null, "pi_test_456"]);
    expect(client.query.mock.calls[2][1]).toEqual([orderId]);
    expect(client.query.mock.calls[3][1]).toEqual([orderId]);
    expect(client.query.mock.calls[4][1]).toEqual([orderId, "pi_test_456"]);
    expect(client.query.mock.calls[5][1]).toEqual([
      orderId,
      "pi_test_456",
      "checkout_started",
      {
        checkoutSessionId: null,
        eventType: "payment_intent.succeeded",
        paymentIntentId: "pi_test_456"
      }
    ]);
  });

  it("falls back to Stripe IDs when metadata.order_id is missing", async () => {
    const client = createClient();
    mockSuccessfulTransaction(
      client,
      createOrderRow({
        stripe_checkout_session_id: "cs_test_fallback",
        stripe_payment_intent_id: "pi_test_fallback"
      }),
    );

    const result = await handleCheckoutSessionCompleted(client, {
      id: "cs_test_fallback",
      metadata: {},
      payment_intent: {
        id: "pi_test_fallback"
      }
    });

    expect(result).toEqual({
      outcome: "updated",
      orderId
    });
    expect(client.query.mock.calls[1][1]).toEqual([
      null,
      "cs_test_fallback",
      "pi_test_fallback"
    ]);
  });

  it("treats already-paid orders as idempotent", async () => {
    const client = createClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          createOrderRow({
            paid_at: new Date("2026-06-01T12:05:00.000Z"),
            payment_status: "paid",
            status: "paid",
            fulfillment_status: "queued"
          })
        ]
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await handlePaymentIntentSucceeded(client, {
      id: "pi_test_paid",
      metadata: {
        order_id: orderId
      }
    });

    expect(result).toEqual({
      outcome: "already_paid",
      orderId
    });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toBe("commit");
  });

  it("does not downgrade terminal orders", async () => {
    const client = createClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          createOrderRow({
            payment_status: "refunded",
            status: "refunded",
            fulfillment_status: "cancelled"
          })
        ]
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await handleCheckoutSessionCompleted(client, {
      id: "cs_test_refunded",
      metadata: {
        order_id: orderId
      },
      payment_intent: "pi_test_refunded"
    });

    expect(result).toEqual({
      outcome: "terminal_state",
      orderId
    });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toBe("commit");
  });

  it("handles unknown orders safely", async () => {
    const client = createClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await handlePaymentIntentSucceeded(client, {
      id: "pi_test_unknown",
      metadata: {
        order_id: "11111111-1111-4111-8111-111111111111"
      }
    });

    expect(result).toEqual({
      outcome: "unknown_order"
    });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toBe("commit");
  });

  it("consumes shared fabric reservations once for a paid order", async () => {
    const client = createClient();
    const fabricId = "9f6cb9ac-78f8-467d-81dd-ff287d4c5605";
    const firstItem = "68367975-5b50-43f4-81bd-b6cbcf1f4301";
    const secondItem = "df157c5d-b354-4bfa-8617-479cc5d55a66";
    client.query
      .mockResolvedValueOnce({
        rows: [
          { fabric_id: fabricId, order_item_id: firstItem, quantity: 1 },
          { fabric_id: fabricId, order_item_id: secondItem, quantity: 2 }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          { fabric_id: fabricId, order_item_id: firstItem, quantity: 1, reservation_id: "389d7af7-7a08-4f7f-9f43-dbc81d132493" },
          { fabric_id: fabricId, order_item_id: secondItem, quantity: 2, reservation_id: "37ab2405-7ba4-4ea9-a28d-e46e9559752e" }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: fabricId }] })
      .mockResolvedValueOnce({ rows: [{ id: "one" }, { id: "two" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await consumeFabricInventory(client, orderId);

    expect(client.query.mock.calls[2][1]).toEqual([fabricId, 3]);
    expect(String(client.query.mock.calls[2][0])).toContain(
      "quantity_sold = quantity_sold + $2",
    );
    expect(String(client.query.mock.calls[3][0])).toContain("status = 'converted'");
    expect(client.query.mock.calls[4][1]).toEqual(expect.arrayContaining([
      fabricId,
      firstItem,
      -1,
      1
    ]));
  });

  it("fails closed when a paid order item has no matching reservation", async () => {
    const client = createClient();
    client.query
      .mockResolvedValueOnce({
        rows: [{
          fabric_id: "9f6cb9ac-78f8-467d-81dd-ff287d4c5605",
          order_item_id: "68367975-5b50-43f4-81bd-b6cbcf1f4301",
          quantity: 1
        }]
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(consumeFabricInventory(client, orderId)).rejects.toThrow(
      "Fabric reservation does not match",
    );
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
