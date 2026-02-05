import { test, expect } from "@playwright/test";

test.describe("Import URL Page - Unauthenticated", () => {
  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/admin/import-url");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Import URL Page - Structure", () => {
  // Note: These tests would require authentication setup
  // For now, we test the redirect behavior and page structure once logged in

  test("page exists and redirects to login when not authenticated", async ({ page }) => {
    const response = await page.goto("/admin/import-url");
    // Should redirect to login
    await expect(page).toHaveURL(/login/);
    expect(response?.status()).toBeLessThan(500);
  });
});

test.describe("Import URL Workflow - Elements", () => {
  test.skip("displays URL input form when authenticated", async ({ page }) => {
    // Skip: requires authentication
    await page.goto("/admin/import-url");

    // Check for URL input
    await expect(page.locator('input[type="url"]')).toBeVisible();

    // Check for fetch button
    await expect(page.getByRole("button", { name: /fetch/i })).toBeVisible();
  });

  test.skip("displays manual paste checkbox", async ({ page }) => {
    // Skip: requires authentication
    await page.goto("/admin/import-url");

    // Check for manual paste option
    await expect(page.locator('input[type="checkbox"]')).toBeVisible();
  });

  test.skip("shows tip about bulk import", async ({ page }) => {
    // Skip: requires authentication
    await page.goto("/admin/import-url");

    // Check for bulk import tip
    await expect(page.locator("text=Bulk Import")).toBeVisible();
  });
});

test.describe("Import URL - Error Handling", () => {
  test.skip("shows error for invalid URL format", async ({ page }) => {
    // Skip: requires authentication
    await page.goto("/admin/import-url");

    const urlInput = page.locator('input[type="url"]');
    await urlInput.fill("not-a-valid-url");

    const fetchButton = page.getByRole("button", { name: /fetch/i });
    await fetchButton.click();

    // Should show validation error
    await expect(page.locator("text=/valid url/i")).toBeVisible();
  });

  test.skip("disables fetch button when URL is empty", async ({ page }) => {
    // Skip: requires authentication
    await page.goto("/admin/import-url");

    const fetchButton = page.getByRole("button", { name: /fetch/i });
    await expect(fetchButton).toBeDisabled();
  });
});

test.describe("Import URL - Manual Paste Mode", () => {
  test.skip("switches to manual paste mode when checkbox is checked", async ({ page }) => {
    // Skip: requires authentication
    await page.goto("/admin/import-url");

    // Click manual paste checkbox
    const checkbox = page.locator('input[type="checkbox"]');
    await checkbox.check();

    // Should show textarea for pasting content
    await expect(page.locator("textarea")).toBeVisible();

    // Should show "Extract Event Data" button
    await expect(page.getByRole("button", { name: /extract/i })).toBeVisible();
  });

  test.skip("can switch back from manual paste mode", async ({ page }) => {
    // Skip: requires authentication
    await page.goto("/admin/import-url");

    // Enable manual paste
    const checkbox = page.locator('input[type="checkbox"]');
    await checkbox.check();
    await expect(page.locator("textarea")).toBeVisible();

    // Click "Back to URL" button
    await page.getByRole("button", { name: /back to url/i }).click();

    // Should show URL input again
    await expect(page.locator('input[type="url"]')).toBeVisible();
  });
});

test.describe("Import URL - API Routes", () => {
  test("fetch API returns 401 for unauthenticated requests", async ({ request }) => {
    const response = await request.get("/api/admin/import-url/fetch?url=https://example.com");
    expect(response.status()).toBe(401);
  });

  test("extract API returns 401 for unauthenticated requests", async ({ request }) => {
    const response = await request.post("/api/admin/import-url/extract", {
      data: { content: "test content" },
    });
    expect(response.status()).toBe(401);
  });

  test("import API returns 401 for unauthenticated requests", async ({ request }) => {
    const response = await request.post("/api/admin/import-url", {
      data: { event: {}, promoterId: "test" },
    });
    expect(response.status()).toBe(401);
  });
});
