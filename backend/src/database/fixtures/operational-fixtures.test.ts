import { describe, expect, it, vi } from "vitest";
import {
  OperationalFixtureInvariantError,
  verifyOperationalFixtures,
  type OperationalFixtureDatabase,
  type OperationalFixtureReferences
} from "./operational.js";

const references: OperationalFixtureReferences = {
  adminUserId: "20000000-0085-4000-8000-000000000100",
  awaitingAdminOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000001", publicOrderNumber: "OP-1" },
  awaitingCustomerOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000002", publicOrderNumber: "OP-2" },
  cancelledOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000003", publicOrderNumber: "OP-3" },
  deliveredOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000004", publicOrderNumber: "OP-4", shipmentId: "20000000-0085-4000-8000-000000000104" },
  failedRefundOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000005", publicOrderNumber: "OP-5" },
  fullRefundOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000006", publicOrderNumber: "OP-6" },
  manualReviewRefundOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000007", publicOrderNumber: "OP-7" },
  partialRefundOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000008", publicOrderNumber: "OP-8" },
  resolvedOrder: { capturedAmountCents: 10000, id: "20000000-0085-4000-8000-000000000009", publicOrderNumber: "OP-9" }
};

describe("operational fixture verifier", () => {
  it("reports only bounded metadata when a worker invariant fails", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{ invalid_count: 1 }] }));
    const db = { query } as unknown as OperationalFixtureDatabase;

    await expect(verifyOperationalFixtures(db, references)).rejects.toEqual(
      expect.objectContaining({
        code: "OPERATIONAL_REFUND_WORK_ELIGIBLE",
        fixtureKey: "operational.refunds",
        tableAlias: "refunds"
      }),
    );

    let error: OperationalFixtureInvariantError | undefined;
    try {
      await verifyOperationalFixtures(db, references);
    } catch (caught) {
      error = caught as OperationalFixtureInvariantError;
    }
    expect(error).toBeDefined();
    expect(error!.message).toBe(
      "Operational fixture invariant failed (OPERATIONAL_REFUND_WORK_ELIGIBLE).",
    );
    expect(error!.message).not.toContain("select");
  });
});
