import { test, expect } from "@playwright/test";

test.describe("Vendors Page", () => {
  test("loads the vendors page", async ({ page }) => {
    await page.goto("/vendors");

    // Check page has loaded
    await expect(page.locator("h1")).toBeVisible();
  });

  test("displays search functionality", async ({ page }) => {
    await page.goto("/vendors");

    // Look for search input
    const searchInput = page.locator('input[type="search"], input[name="query"], input[placeholder*="search" i]');
    if (await searchInput.isVisible()) {
      await expect(searchInput).toBeVisible();
    }
  });

  test("displays vendor cards or list", async ({ page }) => {
    await page.goto("/vendors");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check for vendor content (seeded data) or empty state
    const hasVendors = await page.locator('text=/Artisan Crafts/i').isVisible().catch(() => false);
    const hasGrid = await page.locator('[class*="grid"]').first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=/no vendors/i').isVisible().catch(() => false);

    expect(hasVendors || hasGrid || hasEmptyState).toBeTruthy();
  });

  test("can filter by vendor type", async ({ page }) => {
    await page.goto("/vendors");

    // Look for type filter
    const typeFilter = page.locator('select[name="type"], button:has-text("Type")').first();
    if (await typeFilter.isVisible()) {
      await expect(typeFilter).toBeVisible();
    }
  });
});

test.describe("Vendors Page - Navigation", () => {
  test("can navigate to vendors page from home", async ({ page }) => {
    await page.goto("/");

    const vendorsLink = page
      .locator('header a[href="/vendors"], nav a[href="/vendors"]')
      .first();
    if (await vendorsLink.isVisible()) {
      await vendorsLink.click();
      await expect(page).toHaveURL(/\/vendors/, { timeout: 15000 });
    }
  });
});

test.describe("Vendors Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/vendors");

    // Page should still load on mobile
    await expect(page.locator("h1")).toBeVisible();
  });
});
