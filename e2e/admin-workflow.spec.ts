import { test, expect } from "@playwright/test";

test.describe("Admin Workflow - Event Management", () => {
  test("admin events page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/events");
    await expect(page).toHaveURL(/login/);
  });

  test("admin event edit page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/events/some-event-id/edit");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Admin Workflow - Venue Management", () => {
  test("admin venues page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/venues");
    await expect(page).toHaveURL(/login/);
  });

  test("admin venue edit page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/venues/some-venue-id/edit");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Admin Workflow - Vendor Management", () => {
  test("admin vendors page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/vendors");
    await expect(page).toHaveURL(/login/);
  });

  test("admin vendor edit page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/vendors/some-vendor-id/edit");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Admin Workflow - User Management", () => {
  test("admin users page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Admin Workflow - Duplicate Management", () => {
  test("admin duplicates page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/duplicates");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Admin Workflow - API Security", () => {
  test("admin events API returns 401 for unauthenticated GET", async ({ request }) => {
    const response = await request.get("/api/admin/events");
    expect(response.status()).toBe(401);
  });

  test("admin events API returns 401 for unauthenticated POST", async ({ request }) => {
    const response = await request.post("/api/admin/events", {
      data: { name: "Test Event" },
    });
    expect(response.status()).toBe(401);
  });

  test("admin venues API returns 401 for unauthenticated GET", async ({ request }) => {
    const response = await request.get("/api/admin/venues");
    expect(response.status()).toBe(401);
  });

  test("admin vendors API returns 401 for unauthenticated GET", async ({ request }) => {
    const response = await request.get("/api/admin/vendors");
    expect(response.status()).toBe(401);
  });

  test("admin promoters API returns 401 for unauthenticated GET", async ({ request }) => {
    const response = await request.get("/api/admin/promoters");
    expect(response.status()).toBe(401);
  });

  test("admin users API returns 401 for unauthenticated GET", async ({ request }) => {
    const response = await request.get("/api/admin/users");
    expect(response.status()).toBe(401);
  });
});

test.describe("Admin Workflow - Logs", () => {
  test("admin logs page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin/logs");
    await expect(page).toHaveURL(/login/);
  });

  test("admin logs API returns 401 for unauthenticated GET", async ({ request }) => {
    const response = await request.get("/api/admin/logs");
    expect(response.status()).toBe(401);
  });
});

test.describe("Admin Dashboard", () => {
  test("admin dashboard page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/login/);
  });

  test.skip("admin dashboard shows navigation links when authenticated", async ({ page }) => {
    // Skip: requires authentication
    await page.goto("/admin");

    // Should show navigation to different admin sections
    await expect(page.getByRole("link", { name: /events/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /venues/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /vendors/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /users/i })).toBeVisible();
  });
});
