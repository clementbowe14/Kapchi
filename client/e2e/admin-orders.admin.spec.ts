import { expect, test } from "@playwright/test";

const orderId = "11111111-1111-4111-8111-111111111111";
const money = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const customer = {
  email: "maya@example.com",
  name: "Maya Quispe",
  phone: "+1 555 0100",
  preferredContactMethod: "email",
};
const summary = {
  createdAt: "2026-10-28T14:30:00.000Z",
  customer,
  discount: money(0),
  fulfillmentStatus: "in_progress",
  id: orderId,
  itemCount: 1,
  payment: {
    captured: money(18500),
    currencyIntegrity: "consistent",
    pendingRefunds: money(0),
    refundableBalance: money(18500),
    succeededRefunds: money(0),
  },
  paymentStatus: "paid",
  publicOrderNumber: "KAP-1042",
  revision: 2,
  status: "in_production",
  total: money(18500),
  totalQuantity: 2,
  updatedAt: "2026-10-28T15:00:00.000Z",
};
const detail = {
  ...summary,
  cancelledAt: null,
  completedAt: null,
  contactSnapshot: customer,
  fulfillments: [{
    fulfillmentNumber: 1,
    id: "33333333-3333-4333-8333-333333333333",
    shippingAddressSnapshot: { city: "Brooklyn", country: "US", line1: "100 Main Street", postalCode: "11201", state: "NY" },
    status: "in_progress",
  }],
  items: [{
    catalogReference: { fabricStatus: "active", listingStatus: "active" },
    currency: "USD",
    customizationAsset: { id: "private-id", recordStatus: "uploaded", unavailableReason: null },
    id: "22222222-2222-4222-8222-222222222222",
    production: {
      availability: { font: "present", placement: "present", text: "present", trim: "present" },
      estimateSnapshot: { maximumBusinessDays: 7, minimumBusinessDays: 5, priorityCode: "standard", priorityLabel: "Standard" },
      font: { family: "Garamond" },
      placement: { position: "Left panel" },
      priorityCode: "standard",
      text: { line1: "Class of 2026", line2: "Maya" },
      trim: { color: "Gold", width: "1 inch" },
    },
    productionNotes: "not rendered",
    quantity: 2,
    snapshots: {
      customization: { levelName: "Text (long) + Image + Trim", imageAssetId: "private-id" },
      fabric: { color: "Royal blue" },
      listing: { title: "Classic graduation stole" },
      variant: { currency: "USD", listingPriceVariantId: null, stripePriceId: null, stripeProductId: null, unitAmountMinor: 9250 },
    },
    total: money(18500),
    unitPrice: money(9250),
  }],
  paidAt: "2026-10-28T14:35:00.000Z",
  shipments: [],
  shippedAt: null,
  shipping: { address: { city: "Brooklyn", country: "US", line1: "100 Main Street", postalCode: "11201", state: "NY" }, name: "Maya Quispe" },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/admin/orders**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/admin/orders/${orderId}/timeline`) {
      await route.fulfill({ contentType: "application/json", json: { entries: [], nextCursor: null } });
      return;
    }
    if (url.pathname === `/api/admin/orders/${orderId}`) {
      await route.fulfill({ contentType: "application/json", json: detail });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { nextCursor: null, orders: [summary] } });
  });
});

test("filters the queue and opens stored customization detail", async ({ page }) => {
  await page.goto("/admin/orders");
  await expect(page.getByText("KAP-1042").first()).toBeVisible();
  await expect(page.getByText("Maya Quispe").first()).toBeVisible();

  await page.getByLabel("Order status").selectOption("in_production");
  await page.getByLabel("Date order").selectOption("created_asc");
  const request = page.waitForRequest((candidate) =>
    candidate.url().includes("orderStatus=in_production") && candidate.url().includes("sort=created_asc"));
  await page.getByRole("button", { name: "Apply filters" }).click();
  await request;
  await expect(page).toHaveURL(/status=in_production.*sort=created_asc/);

  await page.getByRole("link", { name: /View (KAP-1042|order)/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${orderId}`));
  await expect(page.getByText("Classic graduation stole")).toBeVisible();
  await expect(page.getByText("Text (long) + Image + Trim")).toBeVisible();
  await expect(page.getByText("Class of 2026 / Maya")).toBeVisible();
  await expect(page.getByText("private-id")).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.getByRole("link", { name: "Back to ongoing orders" }).click();
  await expect(page).toHaveURL(/\/admin\/orders\?status=in_production&sort=created_asc/);
});

test("recovers from a temporary list failure", async ({ page }) => {
  let attempts = 0;
  await page.unroute("**/api/admin/orders**");
  await page.route("**/api/admin/orders**", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        contentType: "application/json",
        headers: { "retry-after": "1" },
        json: { error: "ADMIN_ORDERS_UNAVAILABLE" },
        status: 503,
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { nextCursor: null, orders: [summary] } });
  });
  await page.goto("/admin/orders");
  await expect(page.getByRole("heading", { name: "Orders unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("KAP-1042").first()).toBeVisible();
});

test("handles lifecycle, shipment, notes, and newest-first history", async ({ page }) => {
  let revision = 2;
  let currentDetail: Record<string, unknown> & {
    fulfillments: Array<Record<string, unknown>>;
    shipments: Array<Record<string, unknown>>;
  } = structuredClone(detail);
  const entries: Array<Record<string, unknown>> = [];
  await page.unroute("**/api/admin/orders**");
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/actions/mark-ready-to-ship")) {
      const body = request.postDataJSON();
      expect(body).toEqual({ expectedRevision: 2 });
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
      revision = 3;
      currentDetail = {
        ...currentDetail,
        fulfillmentStatus: "ready_to_ship",
        fulfillments: currentDetail.fulfillments.map((item: Record<string, unknown>) => ({ ...item, status: "ready_to_ship" })),
        revision,
        status: "ready_to_ship",
      };
      entries.unshift({ actorName: "Admin User", actorType: "admin", eventType: "order.ready_to_ship", from: { fulfillmentStatus: "in_progress", orderStatus: "in_production" }, id: "event-ready", kind: "event", occurredAt: "2026-11-02T18:00:00.000Z", to: { fulfillmentStatus: "ready_to_ship", orderStatus: "ready_to_ship" }, visibility: "internal" });
      await route.fulfill({ contentType: "application/json", json: { command: "mark_ready_to_ship", fulfillmentStatus: "ready_to_ship", orderId, orderStatus: "ready_to_ship", paymentStatus: "paid", replayed: false, revision, transitionedAt: "2026-11-02T18:00:00.000Z" } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/actions/confirm-shipment")) {
      const body = request.postDataJSON();
      expect(body).toEqual({ carrier: "USPS", carrierService: "Priority Mail", expectedRevision: 3, trackingNumber: "9400111899" });
      expect(body).not.toHaveProperty("trackingUrl");
      revision = 4;
      const shipment = { carrier: "USPS", carrierService: "Priority Mail", id: "shipment-1", shippedAt: "2026-11-02T18:05:00.000Z", trackingNumber: "9400111899", trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899" };
      currentDetail = { ...currentDetail, fulfillmentStatus: "shipped", fulfillments: currentDetail.fulfillments.map((item: Record<string, unknown>) => ({ ...item, status: "shipped" })), revision, shipments: [{ ...shipment, shipmentNumber: 1, status: "in_transit" }], status: "shipped" };
      entries.unshift({ actorName: "Admin User", actorType: "admin", eventType: "order.shipment_confirmed", from: { fulfillmentStatus: "ready_to_ship", orderStatus: "ready_to_ship" }, id: "event-shipped", kind: "event", occurredAt: "2026-11-02T18:05:00.000Z", to: { fulfillmentStatus: "shipped", orderStatus: "shipped" }, visibility: "internal" });
      await route.fulfill({ contentType: "application/json", json: { command: "confirm_shipment", fulfillmentStatus: "shipped", orderId, orderStatus: "shipped", paymentStatus: "paid", replayed: false, revision, shipment, transitionedAt: "2026-11-02T18:05:00.000Z" } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/notes")) {
      const body = request.postDataJSON();
      entries.unshift({ actorName: "Admin User", actorType: "admin", body: body.body, id: "note-1", kind: "internal_note", occurredAt: "2026-11-02T18:06:00.000Z", status: "sent", visibility: "internal" });
      await route.fulfill({ contentType: "application/json", json: { body: body.body, channel: "internal_note", createdAt: "2026-11-02T18:06:00.000Z", direction: "internal", failedAt: null, id: "note-1", senderType: "admin", sentAt: "2026-11-02T18:06:00.000Z", status: "sent", subject: null }, status: 201 });
      return;
    }
    if (url.pathname.endsWith("/timeline")) {
      expect(url.searchParams.get("sort")).toBe("occurred_desc");
      await route.fulfill({ contentType: "application/json", json: { entries, nextCursor: null } });
      return;
    }
    if (url.pathname === `/api/admin/orders/${orderId}`) {
      await route.fulfill({ contentType: "application/json", json: currentDetail });
      return;
    }
    await route.fallback();
  });

  await page.goto(`/admin/orders/${orderId}`);
  await page.getByRole("button", { name: "Mark ready to ship" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark ready to ship" }).click();
  await expect(page.getByRole("button", { name: "Confirm shipment" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm shipment" }).click();
  await page.getByLabel("Carrier").fill("USPS");
  await page.getByLabel("Carrier service (optional)").fill("Priority Mail");
  await page.getByLabel("Tracking number").fill("9400111899");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm shipment" }).click();
  await expect(page.getByRole("link", { name: "Track shipment" })).toHaveAttribute("rel", "noreferrer noopener");
  await page.getByLabel("Note").fill("Packed after final quality check");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Packed after final quality check")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
