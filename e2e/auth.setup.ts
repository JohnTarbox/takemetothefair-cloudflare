import { test as setup, expect } from "@playwright/test";

setup("authenticate as admin", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("admin@takemetothefair.com");
  await page.locator('input[type="password"]').fill("admin123");
  await Promise.all([
    page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/auth/callback/credentials") &&
        resp.status() === 200
    ),
    page.locator('button[type="submit"]').click(),
  ]);
  await expect(page.locator("body")).toBeVisible();
  await page.context().storageState({ path: ".auth/admin.json" });
});
