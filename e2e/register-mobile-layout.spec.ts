/**
 * OPE-361 — /register must not push its form off-screen on mobile.
 *
 * The bug: the Turnstile container and the form <Card> were SIBLINGS inside a
 * `flex items-center justify-center` wrapper, which is flex-direction:row. While
 * the container was empty it had zero width and the card looked centred; the
 * moment Turnstile injected its ~300px iframe the row became [widget][form],
 * centred as a group. On a ~390px iPhone the combined ~750px row overflowed and
 * the form was pushed past the right edge — a real vendor reported the signup
 * form "disappears" and could not create an account.
 *
 * WHAT THE ASSERTION HAD TO BE, learned the hard way. My first version checked
 * horizontal overflow (scrollWidth > clientWidth). Run against the BROKEN
 * production build it PASSED at 390px and 430px — useless. Probing the real DOM
 * showed why: at those widths the row does not overflow, it CRUSHES. Flex items
 * shrink by default, so the card was squeezed to 58px wide and the form inside
 * it to 8px, with scrollWidth still equal to clientWidth. A sliver of a form is
 * exactly what "it all disappears" looks like on a phone.
 *
 * So the invariant is the form's USABLE WIDTH, not page overflow. Overflow is
 * kept as a secondary check because it is what fails at 320px, but width is what
 * actually catches this bug at the widths real customers use.
 *
 * A screenshot test was rejected: it would go stale on every copy tweak and get
 * re-baselined without thought.
 *
 * The widths are the ones that matter in the field: 320 (iPhone SE), 390
 * (iPhone 12/13/14), 430 (Pro Max).
 */
import { test, expect } from "@playwright/test";

const MOBILE_WIDTHS = [320, 390, 430];

test.describe("/register mobile layout (OPE-361)", () => {
  for (const width of MOBILE_WIDTHS) {
    test(`form stays usably wide at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/register");

      // The form itself must be present before we judge the layout.
      await expect(page.locator("form").first()).toBeVisible();

      // Give the third-party widget its chance to mount — the bug only appeared
      // AFTER Turnstile injected its iframe, so asserting too early would pass
      // against the broken build.
      await page.waitForTimeout(3000);

      // PRIMARY: the card must be usably wide. The wrapper has px-4 (16px a
      // side) and the card caps at max-w-md (448px), so the expected width is
      // min(width - 32, 448). Allowing 70% of that tolerates padding and
      // scrollbar differences while failing hard on the measured 58px.
      const expected = Math.min(width - 32, 448);
      const cardWidth = await page.evaluate(() => {
        const form = document.querySelector("form");
        const card = form?.closest('[class*="max-w-md"]') as HTMLElement | null;
        return card?.getBoundingClientRect().width ?? 0;
      });
      expect(cardWidth).toBeGreaterThan(expected * 0.7);

      // SECONDARY: nothing extends past the viewport. This is what fails at
      // 320px, where the form is not merely crushed but hidden outright.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });

    test(`submit button stays inside the viewport at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/register");
      await page.waitForTimeout(3000);

      const submit = page.getByRole("button", { name: /create account/i });
      await expect(submit).toBeVisible();

      // Visible-in-DOM is not the same as reachable: the broken build still had
      // the button in the tree, just translated off the right edge. Assert its
      // box actually lies within the viewport.
      const box = await submit.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    });
  }

  test("the email field is reachable at 390px — what the customer could not do", async ({
    page,
  }) => {
    // The reported symptom in the customer's words: the form "briefly shows
    // where to enter information but then it all disappears and I am unable to
    // do anything." This is that sentence as an assertion.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/register");
    await page.waitForTimeout(3000);

    const email = page.locator('input[type="email"]').first();
    await expect(email).toBeVisible();
    const box = await email.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
    // Width, not just position: on the broken build this input existed at a
    // sane x but was 8px wide — present, on-screen, and unusable.
    expect(box!.width).toBeGreaterThan(200);

    // And it must actually accept input, not merely occupy space.
    await email.fill("vendor@example.com");
    await expect(email).toHaveValue("vendor@example.com");
  });

  test("OAuth buttons remain usable on mobile", async ({ page }) => {
    // Acceptance explicitly calls this out — the fix must not push the social
    // buttons out of reach while rescuing the form.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/register");
    await page.waitForTimeout(3000);

    for (const name of [/continue with google/i, /continue with facebook/i]) {
      const btn = page.getByRole("button", { name });
      await expect(btn).toBeVisible();
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
    }
  });
});
