import { test, expect, Page } from "@playwright/test";

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.fill('input[type="email"]', "admin@takemetothefair.com");
  await page.fill('input[type="password"]', "admin123");
  await page.click('button[type="submit"]');
  // Wait for redirect away from login
  await page.waitForURL((url) => !url.pathname.includes("/login"), {
    timeout: 15000,
  });
}

async function enableManualPaste(page: Page) {
  // The checkbox label wraps the input, so click the label text
  await page.locator("text=paste content").click();
  // Wait for textarea to appear (confirms React state update happened)
  await expect(page.locator("textarea")).toBeVisible({ timeout: 5000 });
}

test.describe("Import URL Page - Authenticated", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/import-url");
    await page.waitForLoadState("networkidle");
  });

  test("page loads with correct heading and step indicator", async ({
    page,
  }) => {
    // Heading
    await expect(
      page.getByRole("heading", { name: "Import from URL" })
    ).toBeVisible();

    // Step indicator should be visible
    await expect(page.getByText("URL", { exact: true })).toBeVisible();
    await expect(page.getByText("Review", { exact: true })).toBeVisible();

    // Tip about bulk import
    await expect(page.getByText("Tip:")).toBeVisible();
    await expect(page.getByText("Bulk Import page")).toBeVisible();
  });

  test("shows URL input form with fetch button", async ({ page }) => {
    // URL input
    const urlInput = page.locator('input[type="url"]');
    await expect(urlInput).toBeVisible();
    await expect(urlInput).toHaveAttribute(
      "placeholder",
      "https://example.com/event-page"
    );

    // Fetch button is disabled when empty
    const fetchButton = page.getByRole("button", { name: /Fetch Page/i });
    await expect(fetchButton).toBeVisible();
    await expect(fetchButton).toBeDisabled();
  });

  test("fetch button enables when URL is entered", async ({ page }) => {
    const urlInput = page.locator('input[type="url"]');
    await urlInput.fill("https://example.com/some-event");

    const fetchButton = page.getByRole("button", { name: /Fetch Page/i });
    await expect(fetchButton).toBeEnabled();
  });

  test("shows validation error for invalid URL", async ({ page }) => {
    const urlInput = page.locator('input[type="url"]');
    await urlInput.fill("not-a-valid-url");

    const fetchButton = page.getByRole("button", { name: /Fetch Page/i });
    await fetchButton.click();

    // Should show validation error
    await expect(page.getByText(/valid URL/i)).toBeVisible({ timeout: 5000 });
  });

  test("switches to manual paste mode", async ({ page }) => {
    await enableManualPaste(page);

    // Should show "Extract Event Data" button
    await expect(
      page.getByRole("button", { name: /Extract Event Data/i })
    ).toBeVisible();

    // Extract button disabled when textarea is empty
    await expect(
      page.getByRole("button", { name: /Extract Event Data/i })
    ).toBeDisabled();
  });

  test("manual paste mode enables extract button with content", async ({
    page,
  }) => {
    await enableManualPaste(page);

    // Fill textarea
    const textarea = page.locator("textarea");
    await textarea.fill(
      "Blue Hill Fair - September 5-8, 2025 at Blue Hill Fairgrounds"
    );

    // Extract button should be enabled now
    await expect(
      page.getByRole("button", { name: /Extract Event Data/i })
    ).toBeEnabled();
  });

  test("can switch back from manual paste mode", async ({ page }) => {
    await enableManualPaste(page);

    // Click "Back to URL" button
    await page.getByRole("button", { name: /Back to URL/i }).click();

    // Should show URL input again, no textarea
    await expect(page.locator('input[type="url"]')).toBeVisible();
    await expect(page.locator("textarea")).not.toBeVisible();
  });

  test("shows loading step with cancel button when fetching", async ({
    page,
  }) => {
    const urlInput = page.locator('input[type="url"]');
    await urlInput.fill("https://httpbin.org/delay/10");

    const fetchButton = page.getByRole("button", { name: /Fetch Page/i });
    await fetchButton.click();

    // Should show fetching state
    await expect(page.getByText(/Fetching page content/i)).toBeVisible({
      timeout: 5000,
    });

    // Should show cancel button
    const cancelButton = page.getByRole("button", { name: /Cancel/i });
    await expect(cancelButton).toBeVisible();

    // Click cancel
    await cancelButton.click();

    // Should return to url-input step
    await expect(page.locator('input[type="url"]')).toBeVisible({
      timeout: 5000,
    });
  });

  test("shows extracting state with cancel for manual paste", async ({
    page,
  }) => {
    await enableManualPaste(page);

    // Fill with content
    await page
      .locator("textarea")
      .fill(
        "Sample Fair - June 15, 2025 at Town Fairgrounds, 123 Main St, Portland, ME"
      );

    // Click extract
    await page.getByRole("button", { name: /Extract Event Data/i }).click();

    // Should show extracting state
    await expect(page.getByText(/Analyzing page content/i)).toBeVisible({
      timeout: 5000,
    });

    // Cancel button should be visible
    await expect(
      page.getByRole("button", { name: /Cancel/i })
    ).toBeVisible();
  });

  test("back to admin link works", async ({ page }) => {
    const backLink = page.getByRole("link", { name: /Back to Admin/i });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute("href", "/admin");
  });
});
