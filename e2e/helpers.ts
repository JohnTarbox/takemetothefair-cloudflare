import { type Page, expect } from "@playwright/test";

/** Navigate and wait for a heading to confirm the page rendered */
export async function gotoAndWaitForHeading(
  page: Page,
  url: string,
  headingText: string,
  timeout = 15000
) {
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: headingText })
  ).toBeVisible({ timeout });
}

/** Navigate and wait for a specific visible element */
export async function gotoAndWait(
  page: Page,
  url: string,
  selector: string,
  timeout = 15000
) {
  await page.goto(url);
  await expect(page.locator(selector).first()).toBeVisible({ timeout });
}

/** Login as admin using API response wait (not URL-based) */
export async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("admin@takemetothefair.com");
  await page.locator('input[type="password"]').fill("admin123");
  await Promise.all([
    page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/auth/callback/credentials") &&
        resp.status() === 200
    ),
    page.locator('button[type="submit"]').click(),
  ]);
}
