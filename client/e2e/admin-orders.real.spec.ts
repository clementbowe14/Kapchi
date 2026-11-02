import { expect, test } from "@playwright/test";

test("reads the seeded ongoing order through the real Fastify API", async ({ page }) => {
  await page.goto("/admin/orders");
  await expect(page.getByText("LOCAL-SEED-1001").first()).toBeVisible();
  await page.getByRole("link", { name: "View LOCAL-SEED-1001" }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/00000000-0000-4000-8000-000000000153/);
  await expect(page.getByRole("heading", { name: "LOCAL-SEED-1001" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Purchased items" })).toBeVisible();
});
