import { test, expect, type Page } from "@playwright/test";

/**
 * OPE-1488 — one click from a date to that day's Day view, and the date survives
 * every view switch.
 *
 * Data-independent on purpose: CI's E2E server runs on a migrated but EMPTY local
 * D1, and every path here is about navigation, not about events. All locators are
 * scoped to the calendar root (OPE-669: a page-wide `.first()` once hit the wrong
 * element). Dates are explicit URL params, so nothing depends on "today".
 */

const cal = (page: Page) => page.getByTestId("cm-root");
const activeTab = (page: Page) =>
  page.getByRole("tablist", { name: "Calendar view" }).locator('[aria-selected="true"]');

async function open(page: Page, query: string) {
  await page.goto(`/events?view=calendar&${query}`);
  await expect(cal(page)).toBeVisible({ timeout: 20000 });
}

test.describe("Calendar → Day view (OPE-1488)", () => {
  test("Month: clicking a date number opens Day view; Back returns to the month", async ({
    page,
  }) => {
    await open(page, "cal_view=month&cal=2026-10");
    const twenty = cal(page).getByTestId("cm-cell-2026-10-20").locator(".cm-date-number");
    await expect(twenty).toHaveAttribute(
      "aria-label",
      "View all events on Tuesday, October 20, 2026"
    );
    await twenty.click();
    await expect(page).toHaveURL(/cal_view=day/);
    await expect(page).toHaveURL(/date=2026-10-20/);
    await expect(activeTab(page)).toHaveText(/Day/);

    await page.goBack();
    await expect(page).toHaveURL(/cal_view=month/);
    await expect(page).toHaveURL(/cal=2026-10/);
  });

  test("Month: the date number is keyboard-focusable and Enter opens Day view", async ({
    page,
  }) => {
    await open(page, "cal_view=month&cal=2026-10");
    const n = cal(page).getByTestId("cm-cell-2026-10-21").locator(".cm-date-number");
    await expect(n).toHaveAttribute("tabindex", "0");
    await n.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/cal_view=day.*date=2026-10-21|date=2026-10-21.*cal_view=day/);
  });

  test("Month popover: 'View full day' opens Day view for that date", async ({ page }) => {
    await open(page, "cal_view=month&cal=2026-10");
    // Empty cell space opens the day popover (a date number now goes straight to Day).
    await cal(page)
      .getByTestId("cm-cell-2026-10-24")
      .click({ position: { x: 6, y: 60 } });
    const pop = cal(page).getByTestId("cm-day-popover");
    await expect(pop).toBeVisible();
    await expect(pop.locator(".cm-popover-title")).toHaveAttribute("role", "link");
    await pop.getByTestId("cm-view-full-day").click();
    await expect(page).toHaveURL(/date=2026-10-24/);
    await expect(activeTab(page)).toHaveText(/Day/);
  });

  test("Month popover: the date title is a link to Day view", async ({ page }) => {
    await open(page, "cal_view=month&cal=2026-10");
    await cal(page)
      .getByTestId("cm-cell-2026-10-22")
      .click({ position: { x: 6, y: 60 } });
    await cal(page).getByTestId("cm-day-popover").locator(".cm-popover-title").click();
    await expect(page).toHaveURL(/date=2026-10-22/);
    await expect(activeTab(page)).toHaveText(/Day/);
  });

  test("Week: clicking a day header opens Day view for that date", async ({ page }) => {
    await open(page, "cal_view=week&date=2026-10-21");
    const hdr = cal(page).getByTestId("cm-tg-header-2026-10-21");
    await expect(hdr).toHaveAttribute(
      "aria-label",
      "View all events on Wednesday, October 21, 2026"
    );
    await hdr.click();
    await expect(page).toHaveURL(/cal_view=day/);
    await expect(page).toHaveURL(/date=2026-10-21/);
  });

  test("Month moved to November, then the Day tab → Day view in November, not today", async ({
    page,
  }) => {
    await open(page, "cal_view=month&cal=2026-11");
    await page
      .getByRole("tablist", { name: "Calendar view" })
      .getByRole("tab", { name: "Day", exact: true })
      .click();
    await expect(page).toHaveURL(/cal_view=day/);
    await expect(page).toHaveURL(/date=2026-11-01/);
  });

  test("A direct Day link with date= opens on that day", async ({ page }) => {
    await open(page, "cal_view=day&date=2026-10-24");
    await expect(cal(page).getByTestId("cm-tg-header-2026-10-24")).toBeVisible();
  });

  test("Day → Week keeps the week containing the day", async ({ page }) => {
    await open(page, "cal_view=day&date=2026-11-12");
    await page
      .getByRole("tablist", { name: "Calendar view" })
      .getByRole("tab", { name: "Week", exact: true })
      .click();
    await expect(page).toHaveURL(/cal_view=week/);
    await expect(cal(page).getByTestId("cm-tg-header-2026-11-12")).toBeVisible();
  });

  test("Year: clicking a day goes straight to Day view", async ({ page }) => {
    await open(page, "cal_view=year&cal_year=2026");
    await cal(page).getByTestId("cm-year-cell-2026-10-20").click();
    await expect(page).toHaveURL(/cal_view=day/);
    await expect(page).toHaveURL(/date=2026-10-20/);
  });
});
