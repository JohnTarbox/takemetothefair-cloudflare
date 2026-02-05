import { test, expect } from "@playwright/test";

test.describe("Vendor Application Flow - Unauthenticated", () => {
  test("vendor applications page redirects to login", async ({ page }) => {
    await page.goto("/vendor/applications");
    await expect(page).toHaveURL(/login/);
  });

  test("vendor profile page redirects to login", async ({ page }) => {
    await page.goto("/vendor/profile");
    await expect(page).toHaveURL(/login/);
  });

  test("vendor base path requires authentication", async ({ page }) => {
    // Note: /vendor has no index page, so we test /vendor/profile instead
    await page.goto("/vendor/profile");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Vendor Application Flow - Public Event Pages", () => {
  test("events listing page is publicly accessible", async ({ page }) => {
    const response = await page.goto("/events");
    expect(response?.status()).toBeLessThan(500);
    // Should NOT redirect to login
    await expect(page).not.toHaveURL(/login/);
  });

  test("events page has content", async ({ page }) => {
    await page.goto("/events");
    // Should have a heading
    await expect(page.locator("h1, h2")).toBeVisible();
  });

  test.skip("event detail page shows vendor apply button when logged in as vendor", async ({ page }) => {
    // Skip: requires authentication and a real event slug
    await page.goto("/events/some-event-slug");
    await expect(page.getByRole("button", { name: /apply/i })).toBeVisible();
  });
});

test.describe("Vendor Application Flow - API Security", () => {
  test("favorites API requires authentication for POST", async ({ request }) => {
    const response = await request.post("/api/favorites", {
      data: { entityType: "EVENT", entityId: "test-id" },
    });
    expect(response.status()).toBe(401);
  });

  test("favorites API requires authentication for DELETE", async ({ request }) => {
    const response = await request.delete("/api/favorites?entityType=EVENT&entityId=test-id");
    expect(response.status()).toBe(401);
  });
});

test.describe("Vendor Profile - Unauthenticated", () => {
  test("vendor profile edit requires authentication", async ({ page }) => {
    await page.goto("/vendor/profile");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Vendor Public Profiles", () => {
  test("vendors listing page is publicly accessible", async ({ page }) => {
    const response = await page.goto("/vendors");
    expect(response?.status()).toBeLessThan(500);
    // Should NOT redirect to login
    await expect(page).not.toHaveURL(/login/);
  });

  test("vendors page has content", async ({ page }) => {
    await page.goto("/vendors");
    // Should have a heading
    await expect(page.locator("h1, h2")).toBeVisible();
  });
});

test.describe("Vendor Application - Structure", () => {
  test.skip("applications page shows empty state for vendor without applications", async ({ page }) => {
    // Skip: requires authentication as a vendor user
    await page.goto("/vendor/applications");

    // Should show empty state message
    await expect(page.locator("text=/no applications/i")).toBeVisible();

    // Should show link to browse events
    await expect(page.getByRole("link", { name: /browse events/i })).toBeVisible();
  });

  test.skip("applications page shows application cards when vendor has applications", async ({ page }) => {
    // Skip: requires authentication as a vendor with applications
    await page.goto("/vendor/applications");

    // Should show application cards with status badges
    await expect(page.locator("[data-testid='application-card']")).toBeVisible();
  });
});

test.describe("Event Application Modal", () => {
  test.skip("apply modal opens when clicking apply button", async ({ page }) => {
    // Skip: requires authentication and a real event page
    await page.goto("/events/some-event-slug");

    await page.getByRole("button", { name: /apply/i }).click();

    // Should show application modal/form
    await expect(page.locator("[role='dialog']")).toBeVisible();
  });

  test.skip("apply modal has required fields", async ({ page }) => {
    // Skip: requires authentication and a real event page
    await page.goto("/events/some-event-slug");

    await page.getByRole("button", { name: /apply/i }).click();

    // Should show submit button
    await expect(page.getByRole("button", { name: /submit/i })).toBeVisible();
  });
});
