import { test, expect } from "./fixtures";
import { gotoAndWaitForHeading } from "./helpers";

test.describe("Events Page", () => {
  test("loads the events page", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/events", "Browse Events");
  });

  test("displays search functionality", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/events", "Browse Events");

    // OPE-1669 — scoped to #main-content: the streamed hidden Suspense segment
    // (`<div hidden id="S:n">`, after </main>) can briefly hold a second copy of
    // this input. See e2e/calendar-day-links.spec.ts's `cal()`.
    const searchInput = page
      .locator("#main-content")
      .locator('input[type="search"], input[name="query"], input[placeholder*="search" i]');
    await expect(searchInput).toBeVisible();
  });

  test("displays event cards or list", async ({ page }) => {
    await gotoAndWaitForHeading(page, "/events", "Browse Events");

    // Check for event count indicator or empty state
    const hasEvents = await page
      .locator("text=/\\d+ events?/i")
      .first()
      .isVisible()
      .catch(() => false);
    const hasEmptyState = await page
      .locator("text=/no events/i")
      .isVisible()
      .catch(() => false);

    expect(hasEvents || hasEmptyState).toBeTruthy();
  });
});

test.describe("Events Page - Navigation", () => {
  test("can navigate to events page from home", async ({ page }) => {
    await page.goto("/");

    const eventsLink = page.locator('header a[href="/events"], nav a[href="/events"]').first();
    await expect(eventsLink).toBeVisible();
    await eventsLink.click();
    await expect(page).toHaveURL(/\/events/, { timeout: 15000 });
  });
});

test.describe("Events Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/events");
    // OPE-1669 — scoped: the streamed hidden Suspense segment can briefly hold
    // a second <h1>. See e2e/calendar-day-links.spec.ts's `cal()`.
    await expect(page.locator("#main-content h1")).toBeVisible();
  });
});
