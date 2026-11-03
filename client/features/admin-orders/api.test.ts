import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminOrdersApiError,
  fetchAdminOrder,
  fetchAdminOrders,
  parseAdminOrderSearchPage,
  serializeAdminOrderFilters,
  withAdminToken,
} from "./api";
import { createAdminOrderPage } from "./test-fixtures";

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
});
