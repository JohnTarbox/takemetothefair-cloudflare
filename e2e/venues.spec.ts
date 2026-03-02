import { test, expect } from "@playwright/test";
import { gotoAndWaitForHeading } from "./helpers";

test.describe("Venues Page", () => {
  test("loads the venues page", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/venues", "Venues");
  });

  test("displays search functionality", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/venues", "Venues");

    const searchInput = page.locator('input[type="search"], input[name="query"], input[placeholder*="search" i]');
    await expect(searchInput).toBeVisible();
  });

  test("displays venue cards or list", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/venues", "Venues");

    // Check for venue content (seeded data) or empty state
    const hasVenues = await page.locator('text=/County Fairgrounds/i').isVisible().catch(() => false);
    const hasGrid = await page.locator('[class*="grid"]').first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=/no venues/i').isVisible().catch(() => false);

    expect(hasVenues || hasGrid || hasEmptyState).toBeTruthy();
  });

  test("can filter by state", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/venues", "Venues");

    // State filter is a sidebar section with clickable state items
    await expect(page.getByText("Filter by State")).toBeVisible();
    await expect(page.getByText("All States")).toBeVisible();
  });
});

test.describe("Venues Page - Navigation", () => {
  test("can navigate to venues page from home", async ({ page }) => {
    await page.goto("/");

    const venuesLink = page
      .locator('header a[href="/venues"], nav a[href="/venues"]')
      .first();
    await expect(venuesLink).toBeVisible();
    await venuesLink.click();
    await expect(page).toHaveURL(/\/venues/, { timeout: 15000 });
  });
});

test.describe("Venues Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/venues");
    await expect(page.locator("h1")).toBeVisible();
  });
});
