import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { browserApi, expect, test } from "./staging/support";
import type { StagingFixtureManifest } from "./staging/support";

test.describe("deployed checkout and customer order seams", () => {
  async function startCheckout(page: Page, manifest: StagingFixtureManifest) {
    const policy = await browserApi(page, "/payments/checkout-policy");
    expect(policy.status).toBe(200);
    const policyBody = policy.body as { bundleVersion: string };
    const checkout = await browserApi(page, "/payments/checkout-sessions", {
      body: {
        ...manifest.checkout.contact,
        policyAssertion: {
          bundleVersion: policyBody.bundleVersion,
          returnsAcknowledged: true,
          termsAgreed: true,
        },
      },
      method: "POST",
    });
    expect(checkout.status).toBe(201);
    const result = checkout.body as { checkoutSessionId?: string; url?: string };
    expect(result.checkoutSessionId).toMatch(/^cs_test_/);
    expect(new URL(result.url!).hostname).toBe("checkout.stripe.com");
    return { checkoutSessionId: result.checkoutSessionId!, url: result.url! };
  }

  async function fillStripePayment(page: Page, checkoutUrl: string, cardNumber: string) {
    await page.goto(checkoutUrl);
    await page.locator('input[name="cardNumber"]').fill(cardNumber);
    await page.locator('input[name="cardExpiry"]').fill("1234");
    await page.locator('input[name="cardCvc"]').fill("123");
    const name = page.locator('input[name="billingName"]');
    if (await name.isVisible()) await name.fill("Kapchi Staging");
    await page.getByRole("button", { name: /pay|submit/i }).click();
  }

  async function completeStripePayment(page: Page, checkoutUrl: string) {
    await fillStripePayment(page, checkoutUrl, "4242424242424242");
    await page.waitForURL((url) =>
      url.origin === new URL(process.env.E2E_STAGING_STOREFRONT_ORIGIN!).origin
      && url.pathname.includes("/checkout/confirmation"),
    );
    await expect(page.getByText(/order|payment/i).first()).toBeVisible();
  }

  test(
    "[CHECKOUT-GUEST-SUCCESS] creates a real guest test-mode checkout session",
    { annotation: { type: "scenario-owner", description: "guest" } },
    async ({ page, manifest }, testInfo) => {
      test.skip(testInfo.project.name !== "guest", "guest project owns this flow");
      await page.goto("/");
      const added = await browserApi(page, "/cart/items", {
        body: manifest.cartItems.none.request,
        headers: { "idempotency-key": `staging-${randomUUID()}` },
        method: "POST",
      });
      expect(added.status).toBe(201);
      await completeStripePayment(page, (await startCheckout(page, manifest)).url);
    },
  );

  test(
    "[CHECKOUT-AUTH-SUCCESS] creates a real customer test-mode checkout session",
    { annotation: { type: "scenario-owner", description: "customer" } },
    async ({ page, manifest }, testInfo) => {
      test.skip(testInfo.project.name !== "customer", "customer project owns this flow");
      await page.goto("/cart");
      await completeStripePayment(page, (await startCheckout(page, manifest)).url);
    },
  );

  test(
    "[CHECKOUT-CANCEL-DECLINE] exercises declined payment and Stripe cancellation without losing the cart",
    { annotation: { type: "scenario-owner", description: "guest" } },
    async ({ page, manifest }, testInfo) => {
      test.skip(testInfo.project.name !== "guest", "guest project owns cancellation proof");
      await page.goto("/");
      const added = await browserApi(page, "/cart/items", {
        body: manifest.cartItems.none.request,
        headers: { "idempotency-key": `staging-${randomUUID()}` },
        method: "POST",
      });
      expect(added.status).toBe(201);

      const declined = await startCheckout(page, manifest);
      await fillStripePayment(page, declined.url, "4000000000000002");
      await expect(page.getByText(/declined|not accepted|try another/i).first()).toBeVisible();
      await page.goto("/cart");
      const declinedStatus = await browserApi(
        page,
        `/payments/checkout-sessions/${encodeURIComponent(declined.checkoutSessionId)}/status`,
      );
      expect(declinedStatus.status).toBe(200);
      expect(JSON.stringify(declinedStatus.body)).not.toContain('"paymentStatus":"paid"');

      const cancelled = await startCheckout(page, manifest);
      await page.goto(cancelled.url);
      const cancel = page.getByRole("link", { name: /back|cancel|return/i }).first();
      await expect(cancel).toBeVisible();
      await cancel.click();
      await page.waitForURL((url) =>
        url.origin === new URL(process.env.E2E_STAGING_STOREFRONT_ORIGIN!).origin,
      );
      const cancelledStatus = await browserApi(
        page,
        `/payments/checkout-sessions/${encodeURIComponent(cancelled.checkoutSessionId)}/status`,
      );
      expect(cancelledStatus.status).toBe(200);
      expect(JSON.stringify(cancelledStatus.body)).not.toContain('"paymentStatus":"paid"');

      const cart = await browserApi(page, "/cart");
      expect(cart.status).toBe(200);
      expect((cart.body as { totalQuantity?: number }).totalQuantity).toBeGreaterThan(0);
    },
  );

  test(
    "[ORDER-CUSTOMER-LOOKUP] returns customer-safe order data",
    { annotation: { type: "scenario-owner", description: "guest" } },
    async ({ page, manifest }, testInfo) => {
      test.skip(testInfo.project.name !== "guest", "guest project owns public lookup proof");
      await page.goto("/orders");
      const result = await browserApi(page, "/orders/lookup", {
        body: manifest.orders.customerLookup,
        method: "POST",
      });
      expect(result.status).toBe(200);
      const serialized = JSON.stringify(result.body);
      expect(serialized).not.toMatch(/stripe|sku|authSubject/i);
    },
  );
});
