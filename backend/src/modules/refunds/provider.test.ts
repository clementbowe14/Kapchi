import { describe, expect, it, vi } from "vitest";
import { StripeRefundProvider } from "./provider.js";

function stripeRefund() {
  return {
    amount: 2500,
    charge: "ch_test",
    created: 1_790_000_000,
    currency: "usd",
    failure_reason: null,
    id: "re_test",
    metadata: {
      operation_id: "3de37830-b86f-43bb-a0b1-d6938b85ad59",
      order_id: "719ddc98-6333-4ffd-8040-ce43ac569628"
    },
    payment_intent: "pi_test",
    status: "succeeded"
  } as never;
}

describe("StripeRefundProvider", () => {
  it("preserves the reserved account mode on create responses", async () => {
    const create = vi.fn().mockResolvedValue(stripeRefund());
    const provider = new StripeRefundProvider({ refunds: { create } } as never);

    const result = await provider.createRefund({
      amountCents: 2500,
      currency: "usd",
      idempotencyKey: "kapchi-refund:test",
      livemode: true,
      operationId: "3de37830-b86f-43bb-a0b1-d6938b85ad59",
      orderId: "719ddc98-6333-4ffd-8040-ce43ac569628",
      paymentIntentId: "pi_test",
      reasonCode: "requested_by_customer"
    });

    expect(result.livemode).toBe(true);
  });

  it("preserves the stored account mode on retrieved refunds", async () => {
    const retrieve = vi.fn().mockResolvedValue(stripeRefund());
    const provider = new StripeRefundProvider({ refunds: { retrieve } } as never);

    const result = await provider.retrieveRefund("re_test", true);

    expect(retrieve).toHaveBeenCalledWith("re_test");
    expect(result.livemode).toBe(true);
  });
});
