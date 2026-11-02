import { expect, test } from "@playwright/test";

test("signed-out visitors cannot request or see admin order data", async ({ page }) => {
  const adminRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/admin/orders")) adminRequests.push(request.url());
  });

  await page.goto("/admin/orders");

  await expect(page.getByRole("heading", { name: "Admin sign-in required" })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: "Sign in" })).toBeVisible();
  expect(adminRequests).toEqual([]);
});
