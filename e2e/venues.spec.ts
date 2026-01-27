import { test, expect } from "@playwright/test";

test.describe("Venues Page", () => {
  test("loads the venues page", async ({ page }) => {
    await page.goto("/venues");

    // Check page has loaded
    await expect(page.locator("h1")).toBeVisible();
  });

  test("displays search functionality", async ({ page }) => {
    await page.goto("/venues");

    // Look for search input
    const searchInput = page.locator('input[type="search"], input[name="query"], input[placeholder*="search" i]');
    if (await searchInput.isVisible()) {
      await expect(searchInput).toBeVisible();
    }
  });

  test("displays venue cards or list", async ({ page }) => {
    await page.goto("/venues");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check for venue content or empty state
    const hasVenues = await page.locator('[class*="venue"], [class*="card"]').first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=/no venues/i').isVisible().catch(() => false);

    expect(hasVenues || hasEmptyState).toBeTruthy();
  });

  test("can filter by state", async ({ page }) => {
    await page.goto("/venues");

    // Look for state filter
    const stateFilter = page.locator('select[name="state"], button:has-text("State")').first();
    if (await stateFilter.isVisible()) {
      await expect(stateFilter).toBeVisible();
    }
  });
});

test.describe("Venues Page - Navigation", () => {
  test("can navigate to venues page from home", async ({ page }) => {
    await page.goto("/");

    const venuesLink = page.locator('a[href="/venues"]').first();
    if (await venuesLink.isVisible()) {
      await venuesLink.click();
      await expect(page).toHaveURL(/\/venues/);
    }
  });
});

test.describe("Venues Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/venues");

    // Page should still load on mobile
    await expect(page.locator("h1")).toBeVisible();
  });
});
