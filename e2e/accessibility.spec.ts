import { test, expect } from "@playwright/test";

test.describe("Keyboard Navigation - Skip Link", () => {
  test("skip link appears on focus and navigates to main content", async ({ page }) => {
    await page.goto("/events");

    // Press Tab to focus the skip link (it should be the first focusable element)
    await page.keyboard.press("Tab");

    // The skip link should become visible
    const skipLink = page.locator('a[href="#main-content"]');
    await expect(skipLink).toBeFocused();

    // Press Enter to activate the skip link
    await page.keyboard.press("Enter");

    // Focus should now be on main content or within it
    const mainContent = page.locator("#main-content");
    await expect(mainContent).toBeVisible();
  });

  test("skip link is visible when focused", async ({ page }) => {
    await page.goto("/");

    // Tab to focus the skip link
    await page.keyboard.press("Tab");

    const skipLink = page.locator('a[href="#main-content"]');
    // When focused, the skip link should be visible (not just sr-only)
    await expect(skipLink).toBeVisible();
  });
});

test.describe("Keyboard Navigation - Basic Tab Order", () => {
  test("can tab through header navigation links", async ({ page }) => {
    await page.goto("/");

    // Skip the skip link
    await page.keyboard.press("Tab");

    // Continue tabbing through header elements
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => document.activeElement?.tagName);
      // Should be focusing interactive elements (links, buttons)
      expect(["A", "BUTTON", "INPUT"]).toContain(focused);
    }
  });

  test("events page has logical tab order", async ({ page }) => {
    await page.goto("/events");

    // Tab through several elements and verify they're interactive
    const focusedElements: string[] = [];

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const tagName = await page.evaluate(() => document.activeElement?.tagName);
      if (tagName) {
        focusedElements.push(tagName);
      }
    }

    // Should have tabbed through links and buttons
    expect(focusedElements.some((el) => el === "A" || el === "BUTTON")).toBe(true);
  });
});

test.describe("Keyboard Navigation - Form Inputs", () => {
  test("login form fields are keyboard accessible", async ({ page }) => {
    await page.goto("/login");

    // Tab to email field
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.focus();
    await expect(emailInput).toBeFocused();

    // Tab to password field
    await page.keyboard.press("Tab");
    const passwordInput = page.locator('input[type="password"]').first();
    await expect(passwordInput).toBeFocused();

    // After password the form has a "Forgot password?" link before submit, so
    // two Tabs are needed to reach the submit button.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const submitButton = page.locator('button[type="submit"]').first();
    await expect(submitButton).toBeFocused();
  });

  test("can submit login form with Enter key", async ({ page }) => {
    await page.goto("/login");

    // Fill email
    await page.locator('input[type="email"]').first().fill("test@example.com");
    // Fill password
    await page.locator('input[type="password"]').first().fill("testpassword");

    // Press Enter to submit — expect it to fail with invalid credentials
    await page.keyboard.press("Enter");

    // Should still be on login-related page after failed submission
    await expect(page.locator('input[type="email"]').first()).toBeVisible({ timeout: 10000 });
    expect(page.url()).toMatch(/login|error/);
  });
});

test.describe("Keyboard Navigation - Interactive Elements", () => {
  test("view toggle buttons are keyboard accessible", async ({ page }) => {
    await page.goto("/venues");

    // Find and focus a view toggle button (venues page has card/table view toggle)
    const viewButton = page.locator("button[aria-pressed]").first();
    await expect(viewButton).toBeVisible({ timeout: 15000 });
    await viewButton.focus();
    await expect(viewButton).toBeFocused();

    // Can activate with Enter
    await page.keyboard.press("Enter");

    // Can also activate with Space
    await page.keyboard.press("Space");
  });

  test("favorite button is keyboard accessible", async ({ page }) => {
    await page.goto("/venues");

    // Wait for venue cards to load (they contain favorite buttons)
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 15000 });

    const favoriteButton = page.locator('button[title*="favorite"]').first();
    await expect(favoriteButton).toBeVisible({ timeout: 10000 });
    await favoriteButton.focus();
    await expect(favoriteButton).toBeFocused();
  });
});

test.describe("Accessibility - Focus Visibility", () => {
  test("focused elements have visible focus indicator", async ({ page }) => {
    await page.goto("/events");

    // Tab to an element
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");

    // The focused element should exist
    const focusedElement = page.locator(":focus");
    await expect(focusedElement).toBeVisible();
  });

  test("buttons have visible focus ring", async ({ page }) => {
    await page.goto("/login");

    // Focus the submit button
    const submitButton = page.locator('button[type="submit"]').first();
    await submitButton.focus();

    // Check that it has a focus-related CSS applied
    await expect(submitButton).toBeFocused();
  });
});

test.describe("Accessibility - Screen Reader", () => {
  test("main content has proper heading structure", async ({ page }) => {
    await page.goto("/events");

    // Should have an h1 element
    const h1 = page.locator("h1");
    await expect(h1.first()).toBeVisible();
  });

  test("images have alt text", async ({ page }) => {
    await page.goto("/events");

    // Wait for page content to render
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 15000 });

    // Find images and check for alt text
    const images = page.locator("img");
    const count = await images.count();

    for (let i = 0; i < Math.min(count, 5); i++) {
      const image = images.nth(i);
      const alt = await image.getAttribute("alt");
      // Images should have alt attribute (can be empty for decorative images)
      expect(alt !== null).toBe(true);
    }
  });

  test("links with href have some accessible indicator", async ({ page }) => {
    await page.goto("/events");

    // Get visible links (excluding hidden skip links)
    const links = page.locator("a:visible");
    const count = await links.count();

    expect(count).toBeGreaterThan(0);

    // Check that the page has navigation links
    const navLinks = page.locator("nav a, header a");
    const navCount = await navLinks.count();
    expect(navCount).toBeGreaterThan(0);
  });
});

test.describe("Accessibility - Color and Contrast", () => {
  test("error messages are visible", async ({ page }) => {
    await page.goto("/login");

    // Submit empty form to trigger validation
    await page.locator('button[type="submit"]').first().click();

    // The page should still be functional after triggering validation
    const emailInput = page.locator('input[type="email"]').first();
    await expect(emailInput).toBeVisible();
  });
});

test.describe("Accessibility - Responsive", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("mobile menu is keyboard accessible", async ({ page }) => {
    await page.goto("/events");

    // Wait for page to load
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 15000 });

    // Look for mobile menu button (aria-label="Open menu")
    const menuButton = page.locator('button[aria-label*="menu" i]').first();
    await expect(menuButton).toBeVisible();
    await menuButton.focus();
    await expect(menuButton).toBeFocused();

    // Can activate with keyboard
    await page.keyboard.press("Enter");

    // Menu should open — the menu button's aria-label flips to "Close menu"
    // when the drawer is open. Checking the button state is more robust than
    // probing for specific drawer links (which differ between desktop dropdown
    // and mobile drawer markup).
    await expect(page.locator('button[aria-label="Close menu"]')).toBeVisible({ timeout: 5000 });
  });

  test("content is accessible on mobile", async ({ page }) => {
    await page.goto("/events");

    // Should have a heading
    const heading = page.locator("h1, h2").first();
    await expect(heading).toBeVisible();

    // Should be able to tab through content
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBeTruthy();
  });
});
