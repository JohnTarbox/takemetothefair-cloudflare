import { test, expect } from "@playwright/test";

test.describe("Admin Pages - Unauthenticated", () => {
  test("admin dashboard redirects to login", async ({ page }) => {
    await page.goto("/admin");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("admin events page redirects to login", async ({ page }) => {
    await page.goto("/admin/events");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("admin venues page redirects to login", async ({ page }) => {
    await page.goto("/admin/venues");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("admin vendors page redirects to login", async ({ page }) => {
    await page.goto("/admin/vendors");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("admin users page redirects to login", async ({ page }) => {
    await page.goto("/admin/users");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("admin import page redirects to login", async ({ page }) => {
    await page.goto("/admin/import");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("admin import-url page redirects to login", async ({ page }) => {
    await page.goto("/admin/import-url");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("admin duplicates page redirects to login", async ({ page }) => {
    await page.goto("/admin/duplicates");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Admin Edit Pages - Unauthenticated", () => {
  test("event edit page redirects to login", async ({ page }) => {
    await page.goto("/admin/events/test-id/edit");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("venue edit page redirects to login", async ({ page }) => {
    await page.goto("/admin/venues/test-id/edit");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });

  test("vendor edit page redirects to login", async ({ page }) => {
    await page.goto("/admin/vendors/test-id/edit");

    // Should redirect to login
    await expect(page).toHaveURL(/login/);
  });
});
