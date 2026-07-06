import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    expect(client.query.mock.calls[2][1]).toEqual([orderId, "pi_test_123"]);
    expect(client.query.mock.calls[3][1]).toEqual([
      orderId,
      "pi_test_123",
      "checkout_started",
      {
        checkoutSessionId: "cs_test_123",
        eventType: "checkout.session.completed",
        paymentIntentId: "pi_test_123"
      }
    ]);
    expect(client.query.mock.calls[4][0]).toBe("commit");
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
    expect(client.query.mock.calls[2][1]).toEqual([orderId, "pi_test_456"]);
    expect(client.query.mock.calls[3][1]).toEqual([
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
});
