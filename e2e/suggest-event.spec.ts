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

  test('shows validation error for invalid URL', async ({ page }) => {
    await page.goto('/suggest-event');

    // Enter invalid URL
    await page.locator('input[type="url"]').fill('not-a-url');
    await page.getByRole('button', { name: /fetch page/i }).click();

    // Should show error
    await expect(page.locator('text=Please enter a valid URL')).toBeVisible();
  });

  test('can toggle to manual paste mode', async ({ page }) => {
    await page.goto('/suggest-event');

    // Click the checkbox to enable manual paste
    await page.locator('input[type="checkbox"]').click();

    // Should show textarea for pasting content
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.getByRole('button', { name: /extract event data/i })).toBeVisible();
  });

  test('fetches and extracts event data from URL', async ({ page }) => {
    await page.goto('/suggest-event');

    // Enter a test URL
    await page.locator('input[type="url"]').fill('https://www.mainefairs.net/');
    await page.getByRole('button', { name: /fetch page/i }).click();

    // Wait for extraction to complete (may take a few seconds for AI)
    await expect(page.locator('text=Event Details').or(page.locator('text=Event Name'))).toBeVisible({ timeout: 30000 });
  });
});
