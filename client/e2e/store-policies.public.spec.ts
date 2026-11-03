import { expect, test } from "@playwright/test";

test("policy routes and footer remain usable on a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/policies/shipping");
  await expect(page.getByRole("heading", { level: 1, name: "Shipping and Production Policy" })).toBeVisible();
  await expect(page.getByText(/Draft for owner review/)).toBeVisible();
  await expect(page.getByRole("contentinfo").getByRole("link")).toHaveCount(4);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.getByRole("contentinfo").getByRole("link", { name: "Terms of Sale" }).click();
  await expect(page).toHaveURL(/\/policies\/terms$/);
});

test("archived policies are exact and unknown versions return 404", async ({ page }) => {
  await page.goto("/policies/returns/2026-11-03.1");
  await expect(page.getByRole("heading", { level: 1, name: "Returns and Personalized Goods Policy" })).toBeVisible();
  await expect(page.getByText("2026-11-03.1")).toBeVisible();
  const response = await page.goto("/policies/returns/2099-01-01.1");
  expect(response?.status()).toBe(404);
});

test("policy content is server rendered without JavaScript or Clerk", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/policies/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Terms of Sale" })).toBeVisible();
  await context.close();
});

test("guest checkout requires policy assent and submits the exact assertion", async ({ page }) => {
  const digest = "a".repeat(64);
  await page.route("**/api/cart/", (route) => route.fulfill({ json: {
    cartId: "cart-1",
    items: [{
      cartItemId: "item-1",
      currency: "usd",
      customizationSetId: "set-1",
      customizationSummary: { fontOptionId: null, imageAssetId: null, line1: "Class of 2027", line2: "", trimOptionId: null },
      fabricId: null,
      listingId: "listing-1",
      listingPriceVariantId: "price-1",
      listingSlug: "graduation-stole",
      productionEstimate: { minimumBusinessDays: 5, maximumBusinessDays: 7, priorityCode: "standard", priorityLabel: "Standard", qualifier: "Estimate only." },
      quantity: 1,
      title: "Graduation Stole",
      unitAmountCents: 8500,
      validationStatus: "valid",
    }],
    lineItemCount: 1,
    revision: 1,
    subtotalCents: 8500,
    totalQuantity: 1,
    warnings: [],
  } }));
  await page.route("**/api/payments/checkout-policy*", (route) => route.fulfill({ json: {
    schemaVersion: 1,
    bundleVersion: "2026-11-03.1",
    effectiveDate: "2026-11-03",
    checkoutStatement: { version: "2026-11-03.1", digest },
    documents: [
      { key: "shipping", title: "Shipping and Production Policy", role: "notice", version: "2026-11-03.1", digest, path: "/policies/shipping/2026-11-03.1" },
      { key: "returns", title: "Returns and Personalized Goods Policy", role: "acknowledgment", version: "2026-11-03.1", digest, path: "/policies/returns/2026-11-03.1" },
      { key: "privacy", title: "Privacy Policy", role: "notice", version: "2026-11-03.1", digest, path: "/policies/privacy/2026-11-03.1" },
      { key: "terms", title: "Terms of Sale", role: "agreement", version: "2026-11-03.1", digest, path: "/policies/terms/2026-11-03.1" },
    ],
  } }));
  await page.route("**/api/payments/checkout-sessions", (route) => route.fulfill({ status: 201, json: { orderId: "order-1", paymentStatus: "checkout_started", url: "https://checkout.stripe.com/c/pay/cs_test_policy" } }));
  await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ body: "checkout" }));

  await page.goto("/cart");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("textbox", { name: "Phone" }).fill("+15550101010");
  await page.getByRole("button", { name: "Continue to secure checkout" }).click();
  const checkbox = page.getByRole("checkbox", { name: /I agree to the Terms of Sale/ });
  await expect(checkbox).toBeFocused();
  await expect(page.getByText(/Agree to the Terms of Sale/)).toBeVisible();

  await checkbox.check();
  const checkoutRequest = page.waitForRequest("**/api/payments/checkout-sessions");
  await page.getByRole("button", { name: "Continue to secure checkout" }).click();
  const payload = (await checkoutRequest).postDataJSON();
  expect(payload.policyAssertion).toEqual({ bundleVersion: "2026-11-03.1", returnsAcknowledged: true, termsAgreed: true });
  expect(Object.keys(payload.policyAssertion).sort()).toEqual(["bundleVersion", "returnsAcknowledged", "termsAgreed"]);
});
