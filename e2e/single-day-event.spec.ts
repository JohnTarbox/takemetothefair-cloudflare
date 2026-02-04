import { test, expect } from "@playwright/test";

test.describe("Single-Day Event Creation", () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("admin@takemetothefair.com");
    await page.locator('input[type="password"]').fill("admin123");
    await page.locator('button[type="submit"]').click();

    // Wait for login to complete (user name appears in header)
    await expect(page.getByText("Admin User")).toBeVisible({ timeout: 10000 });
  });

  test("shows event hours input for single-day event", async ({ page }) => {
    await page.goto("/admin/events/new");

    // Wait for the form to load
    await expect(page.locator('input[name="name"]')).toBeVisible();

    // Set start and end date to the same day (single-day event)
    const today = new Date();
    const futureDate = new Date(today);
    futureDate.setDate(today.getDate() + 30); // 30 days from now
    const dateStr = futureDate.toISOString().split("T")[0];

    await page.locator("#startDate").fill(dateStr);
    await page.locator("#endDate").fill(dateStr);

    // Verify the Event Hours section appears for single-day event
    await expect(page.getByText("Event Hours")).toBeVisible();

    // Verify time inputs are visible
    await expect(page.locator("#singleDayOpenTime")).toBeVisible();
    await expect(page.locator("#singleDayCloseTime")).toBeVisible();

    // Verify notes input is visible
    await expect(page.locator("#singleDayNotes")).toBeVisible();

    // Verify default times
    await expect(page.locator("#singleDayOpenTime")).toHaveValue("10:00");
    await expect(page.locator("#singleDayCloseTime")).toHaveValue("18:00");
  });

  test("can modify times for single-day event", async ({ page }) => {
    await page.goto("/admin/events/new");

    // Wait for the form to load
    await expect(page.locator('input[name="name"]')).toBeVisible();

    // Set single-day date
    const today = new Date();
    const futureDate = new Date(today);
    futureDate.setDate(today.getDate() + 30);
    const dateStr = futureDate.toISOString().split("T")[0];

    await page.locator("#startDate").fill(dateStr);
    await page.locator("#endDate").fill(dateStr);

    // Wait for Event Hours section
    await expect(page.getByText("Event Hours")).toBeVisible();

    // Change the times
    await page.locator("#singleDayOpenTime").fill("09:00");
    await page.locator("#singleDayCloseTime").fill("21:00");
    await page.locator("#singleDayNotes").fill("Early bird entry at 8:30 AM");

    // Verify the values were set
    await expect(page.locator("#singleDayOpenTime")).toHaveValue("09:00");
    await expect(page.locator("#singleDayCloseTime")).toHaveValue("21:00");
    await expect(page.locator("#singleDayNotes")).toHaveValue("Early bird entry at 8:30 AM");
  });

  test("shows multi-day toggle for multi-day events", async ({ page }) => {
    await page.goto("/admin/events/new");

    // Wait for the form to load
    await expect(page.locator('input[name="name"]')).toBeVisible();

    // Set multi-day date range
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() + 30);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 2); // 3-day event

    await page.locator("#startDate").fill(startDate.toISOString().split("T")[0]);
    await page.locator("#endDate").fill(endDate.toISOString().split("T")[0]);

    // For multi-day events, should show the toggle checkbox, not Event Hours section
    await expect(page.getByLabel("Different hours on each day")).toBeVisible();

    // Event Hours label should NOT be visible (that's for single-day)
    await expect(page.getByText("Event Hours")).not.toBeVisible();
  });

  test("can create and edit single-day event with custom times", async ({ page }) => {
    await page.goto("/admin/events/new");

    // Wait for the form to load
    await expect(page.locator('input[name="name"]')).toBeVisible();

    // Fill in required fields
    const eventName = `Test Single Day Event ${Date.now()}`;
    await page.locator('input[name="name"]').fill(eventName);

    // Wait for promoters to load, then select one
    const promoterSelect = page.locator("#promoterId");
    // Wait for at least 2 options (including the "Select a promoter" placeholder)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.querySelectorAll("option").length >= 2,
      "#promoterId",
      { timeout: 10000 }
    );
    await promoterSelect.selectOption({ index: 1 });

    // Set single-day date
    const today = new Date();
    const futureDate = new Date(today);
    futureDate.setDate(today.getDate() + 60); // 60 days from now
    const dateStr = futureDate.toISOString().split("T")[0];

    await page.locator("#startDate").fill(dateStr);
    await page.locator("#endDate").fill(dateStr);

    // Wait for Event Hours section and set custom times
    await expect(page.getByText("Event Hours")).toBeVisible();

    // Clear and type to ensure onChange fires
    const openTimeInput = page.locator("#singleDayOpenTime");
    const closeTimeInput = page.locator("#singleDayCloseTime");

    await openTimeInput.clear();
    await openTimeInput.fill("09:00");
    await openTimeInput.blur();

    await closeTimeInput.clear();
    await closeTimeInput.fill("21:00");
    await closeTimeInput.blur();

    // Small wait for state to propagate
    await page.waitForTimeout(500);

    // Submit the form
    await page.locator('button[type="submit"]').click();

    // Wait for redirect to events list
    await page.waitForURL(/\/admin\/events$/, { timeout: 10000 });

    // Find and click the edit link for our event
    const eventRow = page.locator(`text=${eventName}`).first();
    await expect(eventRow).toBeVisible();

    // Click on the event name/row to find the edit button
    const editLink = page.locator(`a[href*="/edit"]`).filter({ hasText: /edit/i }).first();
    if (await editLink.isVisible()) {
      await editLink.click();
    } else {
      // Try finding edit link in the same row as our event
      const row = page.locator("tr", { has: page.locator(`text=${eventName}`) });
      await row.locator('a[href*="/edit"]').click();
    }

    // Wait for edit page to load and get event ID from URL
    await page.waitForURL(/\/admin\/events\/.*\/edit/);
    const url = page.url();
    const eventId = url.match(/\/events\/([^/]+)\/edit/)?.[1];

    // Check API response to verify eventDays were saved
    const apiResponse = await page.request.get(`/api/admin/events/${eventId}`);
    const eventData = await apiResponse.json();

    // Verify eventDays were saved in database
    expect(eventData.eventDays).toBeDefined();
    expect(eventData.eventDays.length).toBe(1);
    expect(eventData.eventDays[0].openTime).toBe("09:00");
    expect(eventData.eventDays[0].closeTime).toBe("21:00");

    await expect(page.locator('input[name="name"]')).toHaveValue(eventName);

    // Wait for Event Hours section and for async data to load
    await expect(page.getByText("Event Hours")).toBeVisible();

    // Wait a bit for async eventDays data to load and sync
    await page.waitForTimeout(2000);

    // Verify the saved times are loaded (with longer timeout for async load)
    await expect(page.locator("#singleDayOpenTime")).toHaveValue("09:00", { timeout: 5000 });
    await expect(page.locator("#singleDayCloseTime")).toHaveValue("21:00", { timeout: 5000 });
  });

  test("switching from multi-day to single-day shows simplified UI", async ({ page }) => {
    await page.goto("/admin/events/new");

    // Wait for the form to load
    await expect(page.locator('input[name="name"]')).toBeVisible();

    // First set multi-day
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() + 30);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 2);

    await page.locator("#startDate").fill(startDate.toISOString().split("T")[0]);
    await page.locator("#endDate").fill(endDate.toISOString().split("T")[0]);

    // Verify multi-day UI
    await expect(page.getByLabel("Different hours on each day")).toBeVisible();

    // Change to single-day by setting end date = start date
    await page.locator("#endDate").fill(startDate.toISOString().split("T")[0]);

    // Now should see single-day UI
    await expect(page.getByText("Event Hours")).toBeVisible();
    await expect(page.locator("#singleDayOpenTime")).toBeVisible();
    await expect(page.getByLabel("Different hours on each day")).not.toBeVisible();
  });
});
