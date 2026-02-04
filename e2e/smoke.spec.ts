import { test, expect } from "@playwright/test";

const publicPages = [
  "/",
  "/events",
  "/venues",
  "/vendors",
  "/about",
  "/contact",
  "/faq",
  "/search-visibility",
  "/privacy",
  "/terms",
  "/for-promoters",
  "/for-vendors",
];

test.describe("Public pages", () => {
  for (const path of publicPages) {
    test(`${path} loads successfully`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(/.+/);
      await expect(page.locator("h1").first()).toBeVisible();
    });
  }
});

test.describe("Vendor detail regression", () => {
  test("/vendors/maine-cardworks-inc loads without null-venue crash", async ({
    page,
  }) => {
    const response = await page.goto("/vendors/maine-cardworks-inc");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Maine Cardworks" })).toBeVisible();
  });
});

test.describe("Sitemap", () => {
  test("sitemap.xml returns valid XML with expected pages", async ({
    request,
  }) => {
    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);

    const body = await response.text();
    expect(body).toContain("<urlset");

    // Static pages
    for (const path of publicPages) {
      expect(body).toContain(path === "/" ? "<loc>" : `${path}</loc>`);
    }

    // Dynamic pages should exist
    expect(body).toContain("/events/");
    expect(body).toContain("/venues/");
    expect(body).toContain("/vendors/");
  });
});

test.describe("Protected page redirects", () => {
  for (const path of ["/dashboard", "/admin"]) {
    test(`${path} redirects to login`, async ({ page }) => {
      await page.goto(path, { waitUntil: "domcontentloaded", timeout: 60000 });
      expect(page.url()).toContain("/login");
    });
  }
});
