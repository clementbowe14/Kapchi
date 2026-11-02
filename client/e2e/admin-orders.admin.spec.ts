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
  shippedAt: null,
  shipping: { address: { city: "Brooklyn", country: "US", line1: "100 Main Street", postalCode: "11201", state: "NY" }, name: "Maya Quispe" },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/admin/orders**", async (route) => {
    const url = new URL(route.request().url());
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
