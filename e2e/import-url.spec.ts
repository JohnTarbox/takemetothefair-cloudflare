import { test, expect } from "@playwright/test";

test.describe("Import URL Page - Unauthenticated", () => {
  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/admin/import-url");
    await expect(page).toHaveURL(/login/);
  });

  test("page exists and redirects to login when not authenticated", async ({ page }) => {
    const response = await page.goto("/admin/import-url");
    await expect(page).toHaveURL(/login/);
    expect(response?.status()).toBeLessThan(500);
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
