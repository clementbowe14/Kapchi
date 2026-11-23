import { randomUUID } from "node:crypto";
import { browserApi, expect, test } from "./staging/support";
import {
  readStagingPlaywrightSettings,
  storefrontBypassHeaders,
} from "../lib/staging-playwright";

const customizations = [
  ["CUSTOM-NONE", "none"],
  ["CUSTOM-SHORT-TEXT", "shortText"],
  ["CUSTOM-LONG-TEXT", "longText"],
  ["CUSTOM-TEXT-IMAGE", "textImage"],
  ["CUSTOM-TEXT-IMAGE-TRIM", "textImageTrim"],
] as const;

function findCreatedItem(body: unknown, cartItemId: string) {
  const items = (body as { items?: Array<Record<string, unknown>> }).items;
  const item = items?.find((candidate) => candidate.cartItemId === cartItemId);
  expect(item, `cart response must include ${cartItemId}`).toBeTruthy();
  return item!;
}

test.describe("deployed cart and customization", () => {
  test(
    "[CART-GUEST-CRUD] [CATALOG-FABRIC] persists add, quantity update, and removal",
    { annotation: { type: "scenario-owner", description: "guest" } },
    async ({ page, manifest }, testInfo) => {
      test.skip(testInfo.project.name !== "guest", "guest project owns this flow");
      await page.goto("/");
      const input = manifest.cartItems.none.request;
      const added = await browserApi(page, "/cart/items", {
        body: input,
        headers: { "idempotency-key": `staging-${randomUUID()}` },
        method: "POST",
      });
      expect(added.status).toBe(201);
      const cart = added.body as { cartItemId?: string; items?: unknown[] };
      expect(cart.cartItemId).toMatch(/^[0-9a-f-]{36}$/);
      expect(cart.items).toHaveLength(1);

      const updated = await browserApi(page, `/cart/items/${cart.cartItemId}`, {
        body: { ...input, quantity: 2 },
        method: "PATCH",
      });
      expect(updated.status).toBe(200);
      expect((updated.body as { totalQuantity?: number }).totalQuantity).toBe(2);

      const removed = await browserApi(page, `/cart/items/${cart.cartItemId}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect((removed.body as { items?: unknown[] }).items).toEqual([]);
    },
  );

  for (const [scenarioId, fixtureKey] of customizations) {
    test(
      `[${scenarioId}] enforces allowed fields, forbidden fields, and the price snapshot`,
      { annotation: { type: "scenario-owner", description: "guest" } },
      async ({ page, manifest }, testInfo) => {
        test.skip(testInfo.project.name !== "guest", "guest project owns this flow");
        await page.goto("/");
        const fixture = manifest.cartItems[fixtureKey];
        expect(fixture.expected.forbiddenOverrides.length).toBeGreaterThan(0);
        const result = await browserApi(page, "/cart/items", {
          body: fixture.request,
          headers: { "idempotency-key": `staging-${randomUUID()}` },
          method: "POST",
        });
        expect(result.status).toBe(201);
        const cartItemId = (result.body as { cartItemId?: string }).cartItemId;
        expect(cartItemId).toMatch(/^[0-9a-f-]{36}$/);
        const item = findCreatedItem(result.body, cartItemId!);
        expect(item.customizationSummary).toEqual(fixture.expected.customizationSummary);
        expect(item.unitAmountCents).toBe(fixture.expected.unitAmountCents);
        expect(JSON.stringify(item)).not.toMatch(/stripePriceId|sku/i);

        for (const forbiddenOverride of fixture.expected.forbiddenOverrides) {
          const rejected = await browserApi(page, "/cart/items", {
            body: { ...fixture.request, ...forbiddenOverride },
            headers: { "idempotency-key": `staging-reject-${randomUUID()}` },
            method: "POST",
          });
          expect([400, 409, 422]).toContain(rejected.status);
        }
      },
    );
  }
});

test.describe("authenticated cart", () => {
  test(
    "[CART-AUTH-CRUD] [CART-CLAIM-MERGE] merges a real guest cart without customization loss",
    { annotation: { type: "scenario-owner", description: "customer" } },
    async ({ browser, page, manifest }, testInfo) => {
      test.skip(testInfo.project.name !== "customer", "customer project owns this flow");
      const settings = readStagingPlaywrightSettings();
      await page.goto("/cart");

      const accountFixture = manifest.cartItems.none;
      const accountAdded = await browserApi(page, "/cart/items", {
        body: accountFixture.request,
        headers: { "idempotency-key": `staging-account-${randomUUID()}` },
        method: "POST",
      });
      expect(accountAdded.status).toBe(201);

      const guestContext = await browser.newContext({
        extraHTTPHeaders: storefrontBypassHeaders(settings.storefrontOrigin, settings),
      });
      try {
        const guestPage = await guestContext.newPage();
        await guestPage.goto(settings.storefrontOrigin);
        const guestFixture = manifest.cartItems.textImageTrim;
        const guestAdded = await browserApi(guestPage, "/cart/items", {
          body: guestFixture.request,
          headers: { "idempotency-key": `staging-guest-${randomUUID()}` },
          method: "POST",
        });
        expect(guestAdded.status).toBe(201);
        const guestCookies = (await guestContext.cookies())
          .filter(({ name }) => /cart|guest/i.test(name));
        expect(guestCookies.length, "guest cart cookie must be observable").toBeGreaterThan(0);
        await page.context().addCookies(guestCookies);

        const claim = await browserApi(page, "/cart/claim", { method: "POST" });
        expect(claim.status).toBe(200);
        const claimedItems = (claim.body as { items?: Array<Record<string, unknown>> }).items ?? [];
        expect(claimedItems.length).toBeGreaterThanOrEqual(2);
        expect(claimedItems).toEqual(expect.arrayContaining([
          expect.objectContaining({
            customizationSummary: guestFixture.expected.customizationSummary,
            unitAmountCents: guestFixture.expected.unitAmountCents,
          }),
        ]));
        expect(JSON.stringify(claim.body)).not.toContain("authSubject");
      } finally {
        await guestContext.close();
      }
    },
  );
});
