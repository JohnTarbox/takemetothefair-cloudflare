import { type Page, expect } from "@playwright/test";

/** Navigate and wait for a heading to confirm the page rendered.
 *
 * Uses { exact: true } on the name match so that a partial match (e.g.
 * "Venues" matching both `<h1>Venues</h1>` and `<h2>Filter venues</h2>`)
 * doesn't trip Playwright strict mode. */
export async function gotoAndWaitForHeading(
  page: Page,
  url: string,
  headingText: string,
  timeout = 15000
) {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: headingText, exact: true })).toBeVisible({
    timeout,
  });
}

/** Navigate and wait for a specific visible element */
export async function gotoAndWait(page: Page, url: string, selector: string, timeout = 15000) {
  await page.goto(url);
  await expect(page.locator(selector).first()).toBeVisible({ timeout });
}

/** Login as admin using API response wait (not URL-based).
 *
 * Locators use .first() because the site layout includes a footer
 * newsletter signup with its own email input + submit button on every
 * page, so the bare selector matches two elements. The login form
 * always renders before the footer in DOM order. */
export async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').first().fill("admin@takemetothefair.com");
  await page.locator('input[type="password"]').first().fill("admin123");
  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes("/api/auth/callback/credentials") && resp.status() === 200
    ),
    page.locator('button[type="submit"]').first().click(),
  ]);
}
