import { test, expect } from '@playwright/test';

test.describe('Suggest Event Page', () => {
  test('page loads and shows URL input form', async ({ page }) => {
    await page.goto('/suggest-event');

    // Check page title
    await expect(page.locator('h1')).toContainText('Suggest an Event');

    // Check URL input is visible
    await expect(page.locator('input[type="url"]')).toBeVisible();

    // Check Fetch Page button exists
    await expect(page.getByRole('button', { name: /fetch page/i })).toBeVisible();
  });

  test('shows error for invalid URL after clicking fetch', async ({ page, browserName }) => {
    // Skip on WebKit - it disables the button for invalid URLs via native HTML5 validation
    test.skip(browserName === 'webkit', 'WebKit uses native HTML5 URL validation which disables the button');

    await page.goto('/suggest-event');

    // Enter invalid URL and click fetch
    await page.locator('input[type="url"]').fill('not-a-url');
    await page.getByRole('button', { name: /fetch page/i }).click();

    // Should show validation error
    await expect(page.locator('text=Please enter a valid URL')).toBeVisible({ timeout: 5000 });
  });

  test('can toggle to manual paste mode', async ({ page }) => {
    await page.goto('/suggest-event');

    // Click the checkbox to enable manual paste
    await page.locator('input[type="checkbox"]').click();

    // Should show textarea for pasting content
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.getByRole('button', { name: /extract event data/i })).toBeVisible();
  });

  test('extracts event data from pasted content', async ({ page }) => {
    await page.goto('/suggest-event');

    // Switch to manual paste mode
    await page.locator('input[type="checkbox"]').click();

    // Paste event content
    await page.locator('textarea').fill('County Fair\nOctober 5-8, 2026\n10am-6pm daily\nCounty Fairgrounds, Portland Maine');
    await page.getByRole('button', { name: /extract event data/i }).click();

    // Wait for extraction to complete (may take a few seconds for AI)
    await expect(page.locator('text=Event Details').or(page.locator('text=Event Name'))).toBeVisible({ timeout: 60000 });
  });
});
