import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminOrdersApiError,
  addInternalOrderNote,
  confirmAdminShipment,
  fetchAdminOrder,
  fetchAdminOrderTimeline,
  fetchAdminOrders,
  parseAdminOrderDetail,
  parseAdminOrderSearchPage,
  parseTimelineEntry,
  runLifecycleCommand,
  serializeAdminOrderFilters,
  withAdminToken,
} from "./api";
import { createAdminOrderDetail, createAdminOrderPage } from "./test-fixtures";

const orderId = "11111111-1111-4111-8111-111111111111";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

describe("admin orders API", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("serializes only supported ongoing filters", () => {
    expect(serializeAdminOrderFilters({ orderStatus: "in_production", sort: "created_asc" }, "next page"))
      .toBe("lifecycle=ongoing&limit=25&sort=created_asc&orderStatus=in_production&cursor=next+page");
  });

  it("sends an authenticated no-store list request", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(createAdminOrderPage()), { status: 200 }));
    await expect(fetchAdminOrders("token-1", { sort: "created_desc" }, new AbortController().signal))
      .resolves.toMatchObject({ orders: [{ publicOrderNumber: "KAP-1042" }] });
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/orders?lifecycle=ongoing&limit=25&sort=created_desc",
      expect.objectContaining({
        cache: "no-store",
        headers: { Accept: "application/json", Authorization: "Bearer token-1" },
      }),
    );
  });

  it("rejects malformed success payloads", () => {
    expect(() => parseAdminOrderSearchPage({ nextCursor: null, orders: [{ id: "only-id" }] }))
      .toThrow(/invalid/);
  });

  it("refreshes the token exactly once after a 401", async () => {
    const getToken = vi.fn()
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    const request = vi.fn()
      .mockRejectedValueOnce(new AdminOrdersApiError("unauthorized", 401))
      .mockResolvedValueOnce("ok");
    await expect(withAdminToken(getToken, request)).resolves.toBe("ok");
    expect(getToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not loop when the refreshed token is also unauthorized", async () => {
    const getToken = vi.fn().mockResolvedValue("token");
    const request = vi.fn().mockRejectedValue(new AdminOrdersApiError("unauthorized", 401));
    await expect(withAdminToken(getToken, request)).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("maps token-provider failures to authorization failures", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("Clerk unavailable"));
    await expect(withAdminToken(getToken, vi.fn())).rejects.toMatchObject({
      code: "TOKEN_UNAVAILABLE",
      status: 401,
    });
  });

  it("rejects invalid detail IDs before making a request", async () => {
    await expect(fetchAdminOrder("token", "not-a-uuid", new AbortController().signal))
      .rejects.toMatchObject({ code: "INVALID_ORDER_ID" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps only the frozen shipment fields and suppresses unsafe links", () => {
    const detail = createAdminOrderDetail({
      shipments: [{
        carrier: "Other",
        carrierService: null,
        id: "shipment-1",
        shipmentNumber: 1,
        shippedAt: "2026-11-02T18:00:00.000Z",
        status: "in_transit",
        trackingNumber: "ABC",
        trackingUrl: "https://attacker.example/track/ABC",
      }],
    });
    const parsed = parseAdminOrderDetail({
      ...detail,
      shipments: [{ ...detail.shipments[0], providerShipmentId: "never-render" }],
    });
    expect(parsed.shipments[0]).toEqual({ ...detail.shipments[0], trackingUrl: null });
    expect(parsed.shipments[0]).not.toHaveProperty("providerShipmentId");
  });

  it("maps timeline actors safely and never exposes additional metadata", () => {
    const parsed = parseTimelineEntry({
      actorName: null,
      actorType: "admin",
      eventType: "order.production_started",
      from: { fulfillmentStatus: "queued", orderStatus: "paid" },
      id: "event-1",
      kind: "event",
      metadata: { auditReason: "never-render" },
      occurredAt: "2026-11-02T18:00:00.000Z",
      to: { fulfillmentStatus: "in_progress", orderStatus: "in_production" },
      visibility: "internal",
    });
    expect(parsed.actorName).toBe("Store admin");
    expect(parsed).not.toHaveProperty("metadata");
  });

  it("rejects malformed or non-allowlisted timeline values", () => {
    expect(() => parseTimelineEntry({
      actorName: "Admin",
      actorType: "admin",
      eventType: "order.secret_event",
      from: null,
      id: "event-1",
      kind: "event",
      occurredAt: "2026-11-02T18:00:00.000Z",
      to: null,
      visibility: "internal",
    })).toThrow(/invalid/);
  });

  it("requests descending history with an opaque cursor", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ entries: [], nextCursor: null }));
    await fetchAdminOrderTimeline("token", orderId, new AbortController().signal, "opaque cursor");
    expect(fetch).toHaveBeenCalledWith(
      `/api/admin/orders/${orderId}/timeline?limit=25&sort=occurred_desc&cursor=opaque+cursor`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }) }),
    );
  });

  it("sends exact lifecycle mutation fields and idempotency header", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      command: "start_production",
      fulfillmentStatus: "in_progress",
      orderId,
      orderStatus: "in_production",
      paymentStatus: "paid",
      replayed: false,
      revision: 3,
      transitionedAt: "2026-11-02T18:00:00.000Z",
    }));
    await runLifecycleCommand("token", orderId, "start_production", { expectedRevision: 2, reason: "Begin work" }, "key-1", new AbortController().signal);
    expect(fetch).toHaveBeenCalledWith(`/api/admin/orders/${orderId}/actions/start-production`, expect.objectContaining({
      body: JSON.stringify({ expectedRevision: 2, reason: "Begin work" }),
      headers: expect.objectContaining({ Authorization: "Bearer token", "Idempotency-Key": "key-1" }),
      method: "POST",
    }));
  });

  it("never sends a tracking URL when confirming shipment", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      command: "confirm_shipment",
      fulfillmentStatus: "shipped",
      orderId,
      orderStatus: "shipped",
      paymentStatus: "paid",
      replayed: false,
      revision: 4,
      shipment: { carrier: "USPS", carrierService: null, id: "shipment-1", shippedAt: "2026-11-02T18:00:00.000Z", trackingNumber: "9400", trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400" },
      transitionedAt: "2026-11-02T18:00:00.000Z",
    }));
    await confirmAdminShipment("token", orderId, { carrier: "USPS", expectedRevision: 3, trackingNumber: "9400" }, "key-2", new AbortController().signal);
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ carrier: "USPS", expectedRevision: 3, trackingNumber: "9400" });
  });

  it.each([[201, false], [200, true]] as const)("derives note replay from HTTP %s", async (status, replayed) => {
    vi.mocked(fetch).mockResolvedValue(response({
      body: "Internal note",
      channel: "internal_note",
      createdAt: "2026-11-02T18:00:00.000Z",
      direction: "internal",
      failedAt: null,
      id: "note-1",
      senderType: "admin",
      sentAt: "2026-11-02T18:00:00.000Z",
      status: "sent",
      subject: null,
    }, status));
    await expect(addInternalOrderNote("token", orderId, "Internal note", "note-key", new AbortController().signal)).resolves.toMatchObject({ replayed });
  });
});
