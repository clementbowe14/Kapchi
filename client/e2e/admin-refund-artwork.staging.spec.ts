import { randomUUID } from "node:crypto";
import { browserApi, expect, test } from "./staging/support";

test.describe("deployed admin, refund, and artwork seams", () => {
  test("[ASSET-ADMIN-ACCESS] non-admin users cannot retrieve production artwork", { annotation: { type: "scenario-owner", description: "non-admin" } }, async ({ page, manifest }, testInfo) => {
    test.skip(testInfo.project.name !== "non-admin", "non-admin project owns denial proof");
    await page.goto("/");
    const result = await browserApi(page, manifest.assets.forbiddenArtworkPath);
    expect([401, 403, 404]).toContain(result.status);
  });

  test("[ADMIN-QUEUE-TRANSITIONS] [FULFILLMENT-TRACKING] admin can read the run-owned order", { annotation: { type: "scenario-owner", description: "admin" } }, async ({ page, manifest }, testInfo) => {
    test.skip(testInfo.project.name !== "admin", "admin project owns fulfillment proof");
    await page.goto("/admin/orders");
    const result = await browserApi(page, `/admin/orders/${encodeURIComponent(manifest.orders.adminOrderId)}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({ id: manifest.orders.adminOrderId }));
    const started = await browserApi(
      page,
      `/admin/orders/${encodeURIComponent(manifest.orders.adminOrderId)}/actions/start-production`,
      {
        body: manifest.orders.adminTransitionBody,
        headers: { "idempotency-key": `staging-start-${randomUUID()}` },
        method: "POST",
      },
    );
    expect(started.status).toBe(200);
    const startedBody = started.body as { revision: number };
    const ready = await browserApi(
      page,
      `/admin/orders/${encodeURIComponent(manifest.orders.adminOrderId)}/actions/mark-ready-to-ship`,
      {
        body: { ...manifest.orders.adminTransitionBody, expectedRevision: startedBody.revision },
        headers: { "idempotency-key": `staging-ready-${randomUUID()}` },
        method: "POST",
      },
    );
    expect(ready.status).toBe(200);
    const readyBody = ready.body as { revision: number };
    const shipped = await browserApi(
      page,
      `/admin/orders/${encodeURIComponent(manifest.orders.adminOrderId)}/actions/confirm-shipment`,
      {
        body: { ...manifest.orders.shipmentBody, expectedRevision: readyBody.revision },
        headers: { "idempotency-key": `staging-ship-${randomUUID()}` },
        method: "POST",
      },
    );
    expect(shipped.status).toBe(200);
  });

  test("[ASSET-UPLOAD-OWNERSHIP] [ASSET-ADMIN-ACCESS] artwork access respects ownership and role", { annotation: { type: "scenario-owner", description: "admin" } }, async ({ page, manifest }, testInfo) => {
    test.skip(testInfo.project.name !== "admin", "admin project owns positive artwork proof");
    await page.goto("/admin/orders");
    const result = await browserApi(page, manifest.assets.adminArtworkPath);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("private");
  });

  test("[ASSET-UPLOAD-OWNERSHIP] customer can create only a run-owned upload intent", { annotation: { type: "scenario-owner", description: "customer" } }, async ({ page, manifest }, testInfo) => {
    test.skip(testInfo.project.name !== "customer", "customer project owns upload intent proof");
    await page.goto("/cart");
    const result = await browserApi(page, "/assets/upload-intents", {
      body: manifest.assets.uploadIntentBody,
      method: "POST",
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      access: "private",
      assetId: expect.any(String),
      pathname: expect.stringContaining("cart"),
    }));
  });

  test("[REFUND-FULL-PARTIAL] submits a run-owned refund intent to the real staging API", { annotation: { type: "scenario-owner", description: "admin" } }, async ({ page, manifest }, testInfo) => {
    test.skip(testInfo.project.name !== "admin", "admin project owns refund proof");
    await page.goto("/admin/orders");
    expect(manifest.orders.refunds).toHaveLength(2);
    for (const refund of manifest.orders.refunds) {
      const result = await browserApi(
        page,
        `/admin/orders/${encodeURIComponent(refund.orderId)}/refunds`,
        {
          body: refund.body,
          headers: { "idempotency-key": `staging-refund-${randomUUID()}` },
          method: "POST",
        },
      );
      expect([200, 201, 202]).toContain(result.status);
      expect(result.body).toEqual(expect.objectContaining({
        id: expect.any(String),
        status: expect.any(String),
      }));
    }
  });
});
