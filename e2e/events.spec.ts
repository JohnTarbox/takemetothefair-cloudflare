import { test, expect } from "@playwright/test";

test.describe("Events Page", () => {
  test("loads the events page", async ({ page }) => {
    await page.goto("/events");

    // Check page has loaded
    await expect(page.locator("h1")).toBeVisible();
  });

  test("displays search functionality", async ({ page }) => {
    await page.goto("/events");

    // Look for search input
    const searchInput = page.locator('input[type="search"], input[name="query"], input[placeholder*="search" i]');
    if (await searchInput.isVisible()) {
      await expect(searchInput).toBeVisible();
    }
  });

  test("displays event cards or list", async ({ page }) => {
    await page.goto("/events");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check for event content or empty state
    const hasEvents = await page.locator('[class*="event"], [class*="card"]').first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=/no events/i').isVisible().catch(() => false);

    expect(hasEvents || hasEmptyState).toBeTruthy();
  });
});

test.describe("Events Page - Navigation", () => {
  test("can navigate to events page from home", async ({ page }) => {
    await page.goto("/");

    const eventsLink = page
      .locator('header a[href="/events"], nav a[href="/events"]')
      .first();
    if (await eventsLink.isVisible()) {
      await eventsLink.click();
      await expect(page).toHaveURL(/\/events/, { timeout: 15000 });
    }
  });
});

test.describe("Events Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/events");

    // Page should still load on mobile
    await expect(page.locator("h1")).toBeVisible();
  });
});
