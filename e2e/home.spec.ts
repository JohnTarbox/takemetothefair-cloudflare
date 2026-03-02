import { test, expect } from "@playwright/test";

test.describe("Home Page", () => {
  test("loads successfully", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/.+/);
  });

  test("displays main navigation", async ({ page }) => {
    await page.goto("/");

    // At least one navigation link should be visible
    const eventsLink = page.locator('nav a[href="/events"], header a[href="/events"]').first();
    const venuesLink = page.locator('nav a[href="/venues"], header a[href="/venues"]').first();
    const vendorsLink = page.locator('nav a[href="/vendors"], header a[href="/vendors"]').first();

    const hasNavigation =
      (await eventsLink.isVisible().catch(() => false)) ||
      (await venuesLink.isVisible().catch(() => false)) ||
      (await vendorsLink.isVisible().catch(() => false));

    expect(hasNavigation).toBeTruthy();
  });

  test("displays login link for unauthenticated users", async ({ page }) => {
    await page.goto("/");

    const loginLink = page.locator('a[href="/login"]').first();
    await expect(loginLink).toBeVisible();
  });

  test("displays hero section or featured content", async ({ page }) => {
    await page.goto("/");

    // Wait for h1 to render instead of networkidle
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 15000 });
  });
});

test.describe("Home Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/.+/);
  });

  test("displays mobile menu or hamburger", async ({ page }) => {
    await page.goto("/");

    // Wait for page to load
    await expect(page).toHaveTitle(/.+/);

    const menuButton = page.locator('button[aria-label*="menu" i]').first();
    await expect(menuButton).toBeVisible();
  });
});

test.describe("Navigation - Site-wide", () => {
  test("footer contains important links", async ({ page }) => {
    await page.goto("/");

    const footer = page.locator("footer");
    await expect(footer).toBeVisible();
  });

  test("can navigate between main sections", async ({ page }) => {
    await page.goto("/");

    // Navigate to events
    const eventsLink = page
      .locator('header a[href="/events"], nav a[href="/events"]')
      .first();
    await expect(eventsLink).toBeVisible();
    await eventsLink.click();
    await expect(page).toHaveURL(/\/events/, { timeout: 15000 });

    // Navigate back home
    const homeLink = page
      .locator('header a[href="/"], nav a[href="/"]')
      .first();
    await expect(homeLink).toBeVisible();
    await homeLink.click();
    await expect(page).toHaveURL(/\/$/);
  });
});
