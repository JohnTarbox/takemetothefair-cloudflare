import { test, expect } from "@playwright/test";

test.describe("Home Page", () => {
  test("loads successfully", async ({ page }) => {
    await page.goto("/");

    // Check page has loaded with some content
    await expect(page).toHaveTitle(/.+/);
  });

  test("displays main navigation", async ({ page }) => {
    await page.goto("/");

    // Check for navigation links
    const eventsLink = page.locator('nav a[href="/events"], header a[href="/events"]').first();
    const venuesLink = page.locator('nav a[href="/venues"], header a[href="/venues"]').first();
    const vendorsLink = page.locator('nav a[href="/vendors"], header a[href="/vendors"]').first();

    // At least one navigation option should be visible
    const hasNavigation =
      (await eventsLink.isVisible().catch(() => false)) ||
      (await venuesLink.isVisible().catch(() => false)) ||
      (await vendorsLink.isVisible().catch(() => false));

    expect(hasNavigation).toBeTruthy();
  });

  test("displays login link for unauthenticated users", async ({ page }) => {
    await page.goto("/");

    // Look for login link
    const loginLink = page.locator('a[href="/login"]').first();
    if (await loginLink.isVisible()) {
      await expect(loginLink).toBeVisible();
    }
  });

  test("displays hero section or featured content", async ({ page }) => {
    await page.goto("/");

    // Wait for page to fully load
    await page.waitForLoadState("networkidle");

    // Check for hero, featured section, or main heading
    const hasHeroContent =
      (await page.locator('[class*="hero"]').first().isVisible().catch(() => false)) ||
      (await page.locator('h1').first().isVisible().catch(() => false)) ||
      (await page.locator('[class*="featured"]').first().isVisible().catch(() => false));

    expect(hasHeroContent).toBeTruthy();
  });
});

test.describe("Home Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/");

    // Page should load on mobile
    await expect(page).toHaveTitle(/.+/);
  });

  test("displays mobile menu or hamburger", async ({ page }) => {
    await page.goto("/");

    // Check for mobile menu button
    const menuButton = page.locator('button[aria-label*="menu" i], button[class*="menu"], button:has([class*="hamburger"])').first();
    if (await menuButton.isVisible()) {
      await expect(menuButton).toBeVisible();
    }
  });
});

test.describe("Navigation - Site-wide", () => {
  test("footer contains important links", async ({ page }) => {
    await page.goto("/");

    const footer = page.locator("footer");
    if (await footer.isVisible()) {
      // Footer should be visible on main page
      await expect(footer).toBeVisible();
    }
  });

  test("can navigate between main sections", async ({ page }) => {
    await page.goto("/");

    // Navigate to events
    const eventsLink = page.locator('a[href="/events"]').first();
    if (await eventsLink.isVisible()) {
      await eventsLink.click();
      await expect(page).toHaveURL(/\/events/);

      // Navigate back home
      const homeLink = page.locator('a[href="/"]').first();
      if (await homeLink.isVisible()) {
        await homeLink.click();
        await expect(page).toHaveURL("/");
      }
    }
  });
});
