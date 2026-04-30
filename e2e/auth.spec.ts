import { test, expect } from "@playwright/test";

test.describe("Login Page", () => {
  test("loads the login page", async ({ page }) => {
    await page.goto("/login");

    // Check page has loaded with login form
    await expect(page.locator("h1, h2").first()).toBeVisible();
  });

  test("displays email input", async ({ page }) => {
    await page.goto("/login");

    const emailInput = page.locator('input[type="email"]').first();
    await expect(emailInput).toBeVisible();
  });

  test("displays password input", async ({ page }) => {
    await page.goto("/login");

    const passwordInput = page.locator('input[type="password"]').first();
    await expect(passwordInput).toBeVisible();
  });

  test("displays sign in button", async ({ page }) => {
    await page.goto("/login");

    const signInButton = page.locator('button[type="submit"]').first();
    await expect(signInButton).toBeVisible();
  });

  test("displays link to register page", async ({ page }) => {
    await page.goto("/login");

    const registerLink = page.getByRole("link", { name: "Sign up" });
    await expect(registerLink).toBeVisible();
  });

  test("can navigate to register page", async ({ page }) => {
    await page.goto("/login");

    const registerLink = page.getByRole("link", { name: "Sign up" });
    await expect(registerLink).toBeVisible();
    await registerLink.click();
    // Dev server may need to compile /register on first visit
    await expect(page).toHaveURL("/register", { timeout: 15000 });
  });

  test("shows error for invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.locator('input[type="email"]').first().fill("invalid@example.com");
    await page.locator('input[type="password"]').first().fill("wrongpassword");

    // Wait for the auth response before checking the page state
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes("/api/auth/callback/credentials"), {
        timeout: 15000,
      }),
      page.locator('button[type="submit"]').first().click(),
    ]);

    // Should show error or stay on login page
    await expect(page.locator('input[type="email"]').first()).toBeVisible({ timeout: 10000 });
    expect(page.url()).toMatch(/login|error/);
  });

  test("requires email field", async ({ page }) => {
    await page.goto("/login");

    const emailInput = page.locator('input[type="email"]').first();
    await expect(emailInput).toHaveAttribute("required", "");
  });

  test("requires password field", async ({ page }) => {
    await page.goto("/login");

    const passwordInput = page.locator('input[type="password"]').first();
    await expect(passwordInput).toHaveAttribute("required", "");
  });
});

test.describe("Register Page", () => {
  test("loads the register page", async ({ page }) => {
    await page.goto("/register");

    await expect(page.locator("h1, h2").first()).toBeVisible();
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

    await expect(page.locator('input[type="email"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
  });
});
