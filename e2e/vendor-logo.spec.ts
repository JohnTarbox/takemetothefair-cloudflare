import { test, expect, type Page } from "@playwright/test";

/**
 * OPE-1112 — a vendor can set, replace and remove her OWN logo, through the
 * profile UI, logged in as a vendor.
 *
 * The ticket's acceptance was explicit that the MCP path does not count: it
 * already worked on 2026-09-21, and the maker it was filed for still could not
 * set a logo, because the only vendor-facing control was a text box asking for
 * an image URL. So this drives the real page as the seeded vendor account.
 *
 * What it asserts is the SAVED state, not pixels: locally the upload lands in
 * miniflare's R2 while the stored URL points at the CDN, so the image itself
 * cannot load here. The control's label flipping Upload → Replace, and the
 * Remove button appearing and going away, are the page reading back what the
 * server stored.
 *
 * Runs in ONE project, serially: every project shares the same seeded vendor
 * row, and two browsers uploading/removing its logo in parallel would race.
 */

// 1×1 transparent PNG — real magic bytes, so the pipeline's sniff accepts it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

async function loginAsVendor(page: Page) {
  await page.goto("/login");
  // Scoped to the form holding the password field: the footer's newsletter
  // signup is also an input[type=email] on every page.
  const form = page.locator("form").filter({ has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"]').fill("vendor@example.com");
  await form.locator('input[type="password"]').fill("vendor123");
  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes("/api/auth/callback/credentials") && resp.status() === 200
    ),
    form.locator('button[type="submit"]').click(),
  ]);
}

// OPE-1518 — E2E runs against `next dev`, which compiles each route on its
// first request. This test is the first to touch several of them: the vendor
// profile page, `GET /api/vendor/profile` (the form stays a skeleton until it
// returns — page.tsx's `loading` branch), and `POST`/`DELETE
// /api/vendor-photos/logo`. On a loaded CI runner those first compiles ran past
// the 5s expect default and the 30s test default: the failure snapshot showed
// the vendor logged in, the layout rendered, and no form yet. COLD is the wait
// for anything that can be a route's first request; the budget covers four of
// them plus retries' reloads.
const COLD = { timeout: 20_000 };

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.describe("OPE-1112 — vendor self-service logo", () => {
  test("upload, replace, then remove — as the vendor, through the profile page", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "shares one seeded vendor row; run once");
    await loginAsVendor(page);
    await page.goto("/vendor/profile");

    // The form must LOAD the vendor's own data. Until OPE-1112 it threw on
    // `products` before seeding the form, so every field — logo included —
    // rendered blank for every vendor, and nothing below could be trusted.
    await expect(page.locator('input[name="businessName"]')).toHaveValue("Artisan Crafts", COLD);
    await expect(page.locator('input[name="products"], textarea[name="products"]')).toHaveValue(
      "Pottery, Jewelry, Woodwork"
    );

    const fileInput = page.locator('input[type="file"][accept*="image/png"]').first();
    const removeButton = page.getByRole("button", { name: /^Remove$/ });

    // Start from a clean slate if a previous local run left a logo behind.
    if (await removeButton.isVisible()) {
      await removeButton.click();
      await page.getByRole("button", { name: "Remove" }).last().click();
      await expect(page.getByText("Upload logo")).toBeVisible(COLD);
    }

    await expect(page.getByText("Upload logo")).toBeVisible();

    // Upload.
    const uploaded = page.waitForResponse(
      (r) => r.url().includes("/api/vendor-photos/logo") && r.request().method() === "POST"
    );
    await fileInput.setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    expect((await uploaded).status()).toBe(200);
    await expect(page.getByText("Replace logo")).toBeVisible(COLD);
    await expect(removeButton).toBeVisible();

    // Replace — the same control, now labelled Replace.
    const replaced = page.waitForResponse(
      (r) => r.url().includes("/api/vendor-photos/logo") && r.request().method() === "POST"
    );
    await fileInput.setInputFiles({ name: "logo-2.png", mimeType: "image/png", buffer: PNG });
    expect((await replaced).status()).toBe(200);
    await expect(page.getByText("Replace logo")).toBeVisible();

    // Survives a reload: the page reads the logo back from the server.
    await page.reload();
    await expect(page.getByText("Replace logo")).toBeVisible(COLD);

    // Remove (ConfirmButton: click, then confirm).
    const removed = page.waitForResponse(
      (r) => r.url().includes("/api/vendor-photos/logo") && r.request().method() === "DELETE"
    );
    await removeButton.click();
    await page.getByRole("button", { name: "Remove" }).last().click();
    expect((await removed).status()).toBe(200);
    await expect(page.getByText("Upload logo")).toBeVisible(COLD);

    await page.reload();
    await expect(page.getByText("Upload logo")).toBeVisible(COLD);
  });
});
