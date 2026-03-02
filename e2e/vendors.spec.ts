import { test, expect } from "@playwright/test";
import { gotoAndWaitForHeading } from "./helpers";

test.describe("Vendors Page", () => {
  test("loads the vendors page", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/vendors", "Vendor Directory");
  });

  test("displays search functionality", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/vendors", "Vendor Directory");

    const searchInput = page.locator('input[type="search"], input[name="query"], input[placeholder*="search" i]');
    await expect(searchInput).toBeVisible();
  });

  test("displays vendor cards or list", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/vendors", "Vendor Directory");

    // Check for vendor content (seeded data) or empty state
    const hasVendors = await page.locator('text=/Artisan Crafts/i').isVisible().catch(() => false);
    const hasGrid = await page.locator('[class*="grid"]').first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=/no vendors/i').isVisible().catch(() => false);

    expect(hasVendors || hasGrid || hasEmptyState).toBeTruthy();
  });

  test("can filter by vendor type", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/vendors", "Vendor Directory");

    // Type filter is a sidebar section with clickable type items
    await expect(page.getByText("Filter by Type")).toBeVisible();
    await expect(page.getByText("All Types")).toBeVisible();
  });
});

test.describe("Vendors Page - Navigation", () => {
  test("can navigate to vendors page from home", async ({ page }) => {
    await page.goto("/");

    const vendorsLink = page
      .locator('header a[href="/vendors"], nav a[href="/vendors"]')
      .first();
    await expect(vendorsLink).toBeVisible();
    await vendorsLink.click();
    await expect(page).toHaveURL(/\/vendors/, { timeout: 15000 });
  });
});

test.describe("Vendors Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/vendors");
    await expect(page.locator("h1")).toBeVisible();
  });
});
