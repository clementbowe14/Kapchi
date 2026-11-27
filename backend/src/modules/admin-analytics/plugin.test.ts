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
    refunds: { available: true }
  },
  cohort: {
    basis: "order_created_at",
    bucket: "day",
    bucketTimezone: "America/New_York",
    currency: "usd",
    dateBoundaryTimezone: "UTC",
    drillDown: {
      createdFrom: "2026-09-01",
      createdTo: "2026-09-01",
      currency: "usd",
      lifecycle: "all",
      paidOnly: true
    },
    endDateInclusive: "2026-09-01",
    endExclusive: "2026-09-02T00:00:00.000Z",
    startDateInclusive: "2026-09-01",
    startInclusive: "2026-09-01T00:00:00.000Z"
  },
  comparison: {
    hasBaseline: false,
    previousPeriod: {
      drillDown: {
        createdFrom: "2026-08-31",
        createdTo: "2026-08-31",
        currency: "usd",
        lifecycle: "all",
        paidOnly: true
      },
      endDateInclusive: "2026-08-31",
      endExclusive: "2026-09-01T00:00:00.000Z",
      metrics: {
        averageOrderValueMinor: 0,
        discountMinor: 0,
        grossSalesMinor: 0,
        netSalesMinor: 0,
        paidOrderCount: 0,
        successfulRefundsMinor: 0,
        unitsSold: 0
      },
      startDateInclusive: "2026-08-31",
      startInclusive: "2026-08-31T00:00:00.000Z"
    },
    percentChange: {
      averageOrderValueMinor: null,
      discountMinor: null,
      grossSalesMinor: null,
      netSalesMinor: null,
      paidOrderCount: null,
      successfulRefundsMinor: null,
      unitsSold: null
    }
  },
  fulfillmentBreakdown: [{ count: 2, status: "queued" }],
  metadata: {
    amountUnit: "minor",
    grossSalesDefinition:
      "merchandise_before_discounts_shipping_tax_and_refunds",
    netSalesDefinition:
      "merchandise_less_discounts_less_unallocated_successful_payment_refunds",
    refundCohort: "associated_with_orders_in_created_at_cohort",
    refundCoverage: "recorded_ledger_only",
    source: "postgresql"
  },
  metrics: {
    averageOrderValueMinor: 5700,
    discountMinor: 600,
    grossSalesMinor: 12000,
    netSalesMinor: 9900,
    paidOrderCount: 2,
    successfulRefundsMinor: 1500,
    unitsSold: 3
  },
  paymentBreakdown: [{ count: 2, status: "paid" }],
  timeBuckets: [
    {
      discountMinor: 0,
      endExclusive: "2026-09-01T04:00:00.000Z",
      grossSalesMinor: 0,
      netSalesMinor: 0,
      paidOrderCount: 0,
      startInclusive: "2026-09-01T00:00:00.000Z",
      successfulRefundsMinor: 0,
      unitsSold: 0
    },
    {
      discountMinor: 600,
      endExclusive: "2026-09-02T00:00:00.000Z",
      grossSalesMinor: 12000,
      netSalesMinor: 9900,
      paidOrderCount: 2,
      startInclusive: "2026-09-01T04:00:00.000Z",
      successfulRefundsMinor: 1500,
      unitsSold: 3
    }
  ]
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

  it("returns a single-currency report with ledger-backed comparisons to a verified admin", async () => {
    const app = await buildServer();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: "/admin/analytics/sales?startDate=2026-09-01&endDate=2026-09-01&timezone=America%2FNew_York&currency=USD"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(report);
    expect(getSalesReport).toHaveBeenCalledWith({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "usd",
      endDate: "2026-09-01",
      startDate: "2026-09-01",
      timezone: "America/New_York"
    });
    await app.close();
  });

  it.each([
    ["0100-01-01", "0101-01-01"],
    ["9999-12-31", "9999-12-31"]
  ])("accepts the existing UTC date range %s through %s", async (startDate, endDate) => {
    const app = await buildServer();
    const params = new URLSearchParams({ currency: "usd", endDate, startDate, timezone: "UTC" });
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/analytics/sales?${params}`
    });

    expect(response.statusCode).toBe(200);
    expect(getSalesReport).toHaveBeenCalledWith(expect.objectContaining({ startDate, endDate }));
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
    ["0000-01-01", "0000-01-01", "UTC"],
    ["0100-01-01", "0101-01-02", "UTC"],
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
