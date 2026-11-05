import { describe, expect, it, vi } from "vitest";
import {
  buildOperationalFixturePlan,
  OperationalFixtureInvariantError,
  seedOperationalFixtures,
  type OperationalFixtureReferences
} from "./operational.js";

function references(): OperationalFixtureReferences {
  const order = (suffix: number) => ({
    capturedAmountCents: 10000,
    id: `10000000-0085-4000-8000-${String(suffix).padStart(12, "0")}`,
    publicOrderNumber: `FIXTURE-${suffix}`
  });
  return {
    adminUserId: "10000000-0085-4000-8000-000000000100",
    awaitingAdminOrder: order(1),
    awaitingCustomerOrder: order(2),
    cancelledOrder: order(3),
    deliveredOrder: { ...order(4), shipmentId: "10000000-0085-4000-8000-000000000104" },
    failedRefundOrder: order(5),
    fullRefundOrder: order(6),
    manualReviewRefundOrder: order(7),
    partialRefundOrder: order(8),
    resolvedOrder: order(9)
  };
}

describe("operational fixture catalog", () => {
  it("builds deterministic terminal provider-safe evidence", () => {
    const first = buildOperationalFixturePlan(references());
    const second = buildOperationalFixturePlan(references());

    expect(second).toEqual(first);
    expect(first.conversations.map((entry) => entry.status)).toEqual(
      expect.arrayContaining(["awaiting_admin", "awaiting_customer", "resolved"]),
    );
    expect(first.messages.some((entry) => entry.channel === "internal_note")).toBe(true);
    expect(first.deliveryJobs.every((entry) => ["failed", "succeeded"].includes(entry.status))).toBe(true);
    expect(first.notificationIntents.every((entry) => ["failed", "succeeded"].includes(entry.status))).toBe(true);
    expect(first.stripeWebhooks.every((entry) => ["exhausted", "processed"].includes(entry.status))).toBe(true);
    expect(first.stripeWebhooks.every((entry) => entry.projection.livemode === false)).toBe(true);
    expect(first.messagingWebhooks.every((entry) => ["processed", "rejected"].includes(entry.status))).toBe(true);

    const pending = first.refunds.find((entry) => entry.status === "pending");
    expect(pending).toMatchObject({
      manualReviewRequired: true,
      pendingReason: "unknown_outcome",
      providerRefundId: null
    });
    expect(first.refundEffects.map((entry) => String(entry.status))).not.toContain("pending");
  });

  it("uses unique IDs and synthetic provider/contact identifiers", () => {
    const plan = buildOperationalFixturePlan(references());
    const ids = [
      ...plan.conversations,
      ...plan.messages,
      ...plan.deliveryJobs,
      ...plan.notificationIntents,
      ...plan.refunds,
      ...plan.refundEffects,
      ...plan.stripeWebhooks,
      ...plan.messagingWebhooks
    ].map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(plan)).not.toMatch(/sk_live_|pi_live_|re_live_|evt_live_/);
    expect(JSON.stringify(plan)).not.toMatch(/@(?!example\.test)/);
    expect(plan.payments.every((entry) => entry.paymentIntentId.startsWith("pi_test_fixture_"))).toBe(true);
    expect(plan.refunds.filter((entry) => entry.providerRefundId).every(
      (entry) => entry.providerRefundId!.startsWith("re_test_fixture_"),
    )).toBe(true);
  });

  it("rejects order-role aliasing before any database write", () => {
    const input = references();
    input.resolvedOrder = input.awaitingAdminOrder;

    expect(() => buildOperationalFixturePlan(input)).toThrowError(
      expect.objectContaining({ code: "OPERATIONAL_REFERENCE_COLLISION" }),
    );
  });

  it("redacts ownership and database failures", async () => {
    const secret = "postgres://real-user:real-password@production/private";
    const db = { query: vi.fn() };

    await expect(seedOperationalFixtures(db, {
      claimOwnedRow: vi.fn(async () => { throw new Error(secret); }),
      references: references()
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(OperationalFixtureInvariantError);
      expect(error).toMatchObject({
        code: "OPERATIONAL_FIXTURE_WRITE_REJECTED",
        tableAlias: "order_conversations"
      });
      expect(String(error)).not.toContain(secret);
      return true;
    });
    expect(db.query).not.toHaveBeenCalled();
  });
});
