import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SalesAnalyticsReport } from "./types.js";

vi.mock("../auth/index.js", () => ({
  authMiddleware: async (request: {
    auth: unknown;
    headers: { authorization?: string };
  }) => {
    const token = request.headers.authorization;
    request.auth = token
      ? {
          claims: {},
          permissions: [],
          roles: token === "Bearer admin-token" ? ["admin"] : ["customer"],
          sessionId: null,
          token,
          userId: "user_123"
        }
      : null;
  },
  requireRole: (role: string) => async (
    request: { auth: { roles: string[] } | null },
    reply: { code: (statusCode: number) => { send: (payload: unknown) => void } },
  ) => {
    if (!request.auth) {
      reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Authentication is required.",
        statusCode: 401
      });
      return;
    }
    if (!request.auth.roles.includes(role)) {
      reply.code(403).send({
        error: "FORBIDDEN",
        message: `Missing required role: ${role}`,
        statusCode: 403
      });
    }
  }
}));

const { createAdminAnalyticsPlugin } = await import("./plugin.js");

const report: SalesAnalyticsReport = {
  bestSellers: [{
    grossSalesMinor: 12000,
    label: "Classic Graduation Stole",
    productKey: "classic-graduation-stole",
    unitsSold: 3
  }],
  capabilities: {
    refunds: {
      available: false,
      dependencyIssue: 103,
      reason: "REFUND_LEDGER_UNAVAILABLE"
    }
  },
  cohort: {
    basis: "order_created_at",
    bucket: "day",
    bucketTimezone: "America/New_York",
    currency: "usd",
    dateBoundaryTimezone: "UTC",
    endDateInclusive: "2026-09-30",
    endExclusive: "2026-10-01T00:00:00.000Z",
    startDateInclusive: "2026-09-01",
    startInclusive: "2026-09-01T00:00:00.000Z"
  },
  fulfillmentBreakdown: [{ count: 2, status: "queued" }],
  metadata: {
    amountUnit: "minor",
    grossSalesDefinition:
      "merchandise_before_discounts_shipping_tax_and_refunds",
    netSalesDefinition: "unavailable_until_refund_ledger",
    refundCohort: "associated_with_orders_in_created_at_cohort",
    source: "postgresql"
  },
  metrics: {
    averageOrderValueMinor: 5700,
    discountMinor: 600,
    grossSalesMinor: 12000,
    netSalesMinor: null,
    paidOrderCount: 2,
    successfulRefundsMinor: null,
    unitsSold: 3
  },
  paymentBreakdown: [{ count: 2, status: "paid" }],
  timeBuckets: []
};

describe("admin sales analytics plugin", () => {
  const getSalesReport = vi.fn(async () => report);

  beforeEach(() => {
    getSalesReport.mockClear();
  });

  async function buildServer() {
    const app = fastify({ logger: false });
    await app.register(
      createAdminAnalyticsPlugin({ reader: { getSalesReport } }),
      { prefix: "/admin/analytics" },
    );
    return app;
  }

  it("returns a single-currency report to a verified admin", async () => {
    const app = await buildServer();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: "/admin/analytics/sales?startDate=2026-09-01&endDate=2026-09-30&timezone=America%2FNew_York&currency=USD"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(report);
    expect(getSalesReport).toHaveBeenCalledWith({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "usd",
      endDate: "2026-09-30",
      startDate: "2026-09-01",
      timezone: "America/New_York"
    });
    expect(response.json().metrics).toMatchObject({
      netSalesMinor: null,
      successfulRefundsMinor: null
    });
    await app.close();
  });

  it.each([
    { authorization: undefined, statusCode: 401 },
    { authorization: "Bearer customer-token", statusCode: 403 }
  ])("requires the exact admin role", async ({ authorization, statusCode }) => {
    const app = await buildServer();
    const response = await app.inject({
      ...(authorization ? { headers: { authorization } } : {}),
      method: "GET",
      url: "/admin/analytics/sales?startDate=2026-09-01&endDate=2026-09-30&timezone=UTC&currency=usd"
    });

    expect(response.statusCode).toBe(statusCode);
    expect(getSalesReport).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["2026-02-30", "2026-03-01", "UTC"],
    ["2026-10-01", "2026-09-01", "UTC"],
    ["2025-01-01", "2026-01-02", "UTC"],
    ["2026-09-01", "2026-09-30", "Mars/Olympus_Mons"]
  ])(
    "rejects invalid or unbounded date and timezone combinations",
    async (startDate, endDate, timezone) => {
      const app = await buildServer();
      const params = new URLSearchParams({
        currency: "usd",
        endDate,
        startDate,
        timezone
      });
      const response = await app.inject({
        headers: { authorization: "Bearer admin-token" },
        method: "GET",
        url: `/admin/analytics/sales?${params}`
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("VALIDATION_ERROR");
      expect(getSalesReport).not.toHaveBeenCalled();
      await app.close();
    },
  );
});
