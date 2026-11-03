import { describe, expect, it, vi } from "vitest";
import { projectStripeEvent, StripeWebhookInbox } from "./webhook-inbox.js";

describe("projectStripeEvent", () => {
  it("projects only normalized shipping fields needed for retry", () => {
    const projection = projectStripeEvent({
      api_version: "2026-02-25.clover",
      created: 1_790_000_000,
      data: { object: {
        collected_information: { shipping_details: {
          address: { city: "Boston", country: "US", line1: "1 Main", line2: null, postal_code: "02108", state: "MA" },
          name: "Customer"
        } },
        customer_details: { email: "not-projected@example.test" },
        id: "cs_test", metadata: { order_id: "719ddc98-6333-4ffd-8040-ce43ac569628" },
        object: "checkout.session", payment_intent: "pi_test", payment_status: "paid"
      } },
      id: "evt_checkout", livemode: false, object: "event",
      pending_webhooks: 1, request: null, type: "checkout.session.completed"
    } as never);

    expect(projection).toMatchObject({
      kind: "checkout_session_completed",
      shipping: { address: { postalCode: "02108" }, name: "Customer", status: "valid" }
    });
    expect(JSON.stringify(projection)).not.toContain("not-projected@example.test");
  });

  it("keeps only allowlisted refund fields and metadata", () => {
    const projection = projectStripeEvent({
      account: "acct_test",
      api_version: "2026-02-25.clover",
      created: 1_790_000_000,
      data: {
        object: {
          amount: 2500,
          charge: "ch_test",
          currency: "usd",
          failure_reason: null,
          id: "re_test",
          metadata: {
            customer_email: "private@example.test",
            operation_id: "3de37830-b86f-43bb-a0b1-d6938b85ad59",
            order_id: "719ddc98-6333-4ffd-8040-ce43ac569628"
          },
          object: "refund",
          payment_intent: "pi_test",
          status: "pending"
        }
      },
      id: "evt_test",
      livemode: false,
      object: "event",
      pending_webhooks: 1,
      request: null,
      type: "refund.created"
    } as never);

    expect(projection).toMatchObject({
      eventId: "evt_test",
      kind: "refund",
      metadata: {
        operationId: "3de37830-b86f-43bb-a0b1-d6938b85ad59",
        orderId: "719ddc98-6333-4ffd-8040-ce43ac569628"
      },
      refundId: "re_test"
    });
    expect(JSON.stringify(projection)).not.toContain("private@example.test");
  });

  it("preserves the existing payment success replay fields", () => {
    const projection = projectStripeEvent({
      api_version: "2026-02-25.clover",
      created: 1_790_000_000,
      data: {
        object: {
          amount_received: 5000,
          currency: "usd",
          id: "pi_test",
          latest_charge: "ch_test",
          metadata: { order_id: "719ddc98-6333-4ffd-8040-ce43ac569628" },
          object: "payment_intent",
          status: "succeeded"
        }
      },
      id: "evt_payment",
      livemode: false,
      object: "event",
      pending_webhooks: 1,
      request: null,
      type: "payment_intent.succeeded"
    } as never);

    expect(projection).toMatchObject({
      amountReceived: 5000,
      kind: "payment_intent_succeeded",
      latestChargeId: "ch_test",
      paymentIntentId: "pi_test"
    });
  });
});

describe("StripeWebhookInbox", () => {
  it("scrubs retry-only shipping PII after successful processing", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ stripe_event_id: "evt_ignored" }] })
      .mockResolvedValueOnce({ rows: [] });
    const inbox = new StripeWebhookInbox({ query } as never, {} as never);
    const event = {
      api_version: "2026-02-25.clover", created: 1_790_000_000,
      data: { object: { id: "obj_ignored", object: "unknown" } },
      id: "evt_ignored", livemode: false, object: "event",
      pending_webhooks: 1, request: null, type: "unknown.event"
    } as never;

    await expect(inbox.receive(event, "raw-payload")).resolves.toEqual({
      duplicate: false, processingStatus: "processed"
    });
    expect(String(query.mock.calls[1][0])).toContain("event_projection - 'shipping'");
  });

  it("reports the persisted retry state when a duplicate event arrives", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ processing_status: "retryable" }] });
    const inbox = new StripeWebhookInbox(
      { query } as never,
      {} as never,
    );
    const event = {
      api_version: "2026-02-25.clover",
      created: 1_790_000_000,
      data: { object: { id: "obj_ignored", object: "unknown" } },
      id: "evt_duplicate",
      livemode: false,
      object: "event",
      pending_webhooks: 1,
      request: null,
      type: "unknown.event"
    } as never;

    await expect(inbox.receive(event, "raw-payload")).resolves.toEqual({
      duplicate: true,
      processingStatus: "retryable"
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
