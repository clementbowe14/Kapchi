import { describe, expect, it, vi } from "vitest";
import { readOperationalHealth } from "./health.js";

describe("operational health", () => {
  it("emits counts only and marks exhausted work actionable", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ stripeWebhooks: 1, messageJobs: 0, notificationIntents: 2, refundReconciliations: 0, manualReviewRefunds: 1 }] });
    const result = await readOperationalHealth({ query } as never, new Date("2026-11-05T12:00:00.000Z"));
    expect(result).toMatchObject({
      event: "operations.health.completed",
      actionable: true,
      checkedAt: "2026-11-05T12:00:00.000Z",
      counts: { stripeWebhooks: 1, messageJobs: 0, notificationIntents: 2, refundReconciliations: 0, manualReviewRefunds: 1 }
    });
    expect(JSON.stringify(result)).not.toContain("id");
  });
});
