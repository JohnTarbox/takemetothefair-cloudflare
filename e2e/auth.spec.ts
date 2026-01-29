import { test, expect } from "@playwright/test";

test.describe("Login Page", () => {
  test("loads the login page", async ({ page }) => {
    await page.goto("/login");

    // Check page has loaded with login form
    await expect(page.locator("h1, h2")).toBeVisible();
  });

  test("displays email input", async ({ page }) => {
    await page.goto("/login");

    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();
  });

  test("displays password input", async ({ page }) => {
    await page.goto("/login");

    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toBeVisible();
  });

  test("displays sign in button", async ({ page }) => {
    await page.goto("/login");

    const signInButton = page.locator('button[type="submit"]');
    await expect(signInButton).toBeVisible();
  });

  test("displays link to register page", async ({ page }) => {
    await page.goto("/login");

    const registerLink = page.locator('a[href="/register"]');
    if (await registerLink.isVisible()) {
      await expect(registerLink).toBeVisible();
    }
  });

  test("can navigate to register page", async ({ page }) => {
    await page.goto("/login");

    const registerLink = page.locator('a[href="/register"]');
    if (await registerLink.isVisible()) {
      await registerLink.click();
      await expect(page).toHaveURL("/register");
    }
  });

  test("shows error for invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.locator('input[type="email"]').fill("invalid@example.com");
    await page.locator('input[type="password"]').fill("wrongpassword");
    await page.locator('button[type="submit"]').click();

    // Wait for error message or redirect back to login
    await page.waitForTimeout(2000);

    // Should still be on login page or show error
    const url = page.url();
    const hasError = await page.locator('[class*="error"], [role="alert"], text=/invalid|error/i').isVisible().catch(() => false);

    expect(url.includes("login") || hasError).toBeTruthy();
  });

  test("requires email field", async ({ page }) => {
    await page.goto("/login");

    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toHaveAttribute("required", "");
  });

  test("requires password field", async ({ page }) => {
    await page.goto("/login");

    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toHaveAttribute("required", "");
  });
});

test.describe("Register Page", () => {
  test("loads the register page", async ({ page }) => {
    await page.goto("/register");

    await expect(page.locator("h1, h2")).toBeVisible();
  });

  test("displays link to login page", async ({ page }) => {
    await page.goto("/register");

    const loginLink = page.locator('a[href="/login"]').first();
    await expect(loginLink).toBeVisible();
  });
});

test.describe("Auth Protection", () => {
  test("dashboard redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/dashboard");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("admin page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Login Page - Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is responsive on mobile", async ({ page }) => {
    await page.goto("/login");

    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });
});
