import { test, expect } from "@playwright/test";
import { gotoAndWaitForHeading } from "./helpers";

test.describe("Events Page", () => {
  test("loads the events page", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/events", "Browse Events");
  });

  test("displays search functionality", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/events", "Browse Events");

    const searchInput = page.locator('input[type="search"], input[name="query"], input[placeholder*="search" i]');
    await expect(searchInput).toBeVisible();
  });

  test("displays event cards or list", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/events", "Browse Events");

    // Check for event count indicator or empty state
    const hasEvents = await page.locator('text=/\\d+ events?/i').first().isVisible().catch(() => false);
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
    await expect(eventsLink).toBeVisible();
    await eventsLink.click();
    await expect(page).toHaveURL(/\/events/, { timeout: 15000 });
  });
});

test.describe("Events Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/events");
    await expect(page.locator("h1")).toBeVisible();
  });
});
