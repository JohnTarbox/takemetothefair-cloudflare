import { test, expect, type Page } from "@playwright/test";

/**
 * OPE-1380 — zero CSP violations on the nonce routes.
 *
 * The admin/auth/portal/account routes carry `script-src 'nonce-…'
 * 'strict-dynamic'` with no `'unsafe-inline'`. Any script Next.js, the root
 * layout (gtag/beacon/__name polyfill), next-themes or Turnstile emits without
 * the nonce is BLOCKED — the page then fails to hydrate with no server-side
 * error at all. This spec is the only check that sees that: it listens for
 * `securitypolicyviolation` events and console CSP errors and requires none.
 *
 * Signed out, /admin and /vendor/profile redirect to /login; the spec follows
 * the redirect, so it still asserts the page that actually rendered.
 */

async function collectViolations(page: Page): Promise<() => Promise<string[]>> {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    // Only BLOCKS count. Firefox also WARNS "Ignoring 'self' within
    // script-src: 'strict-dynamic' specified" for the CSP2 fallback sources we
    // keep on purpose, and about unknown directives in Turnstile's own iframe
    // policy — neither blocks anything on our page.
    if (/Content[ -]Security[ -]Policy/i.test(text) && /blocked|refused/i.test(text))
      consoleErrors.push(`console: ${text}`);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
    });
  });
  return async () => {
    const events = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations
    );
    return [...events, ...consoleErrors];
  };
}

const NONCE_ROUTES = ["/login", "/register", "/suggest-event", "/admin", "/vendor/profile"];

for (const path of NONCE_ROUTES) {
  test(`${path} — nonce CSP, zero violations, page hydrates`, async ({ page }) => {
    const violations = await collectViolations(page);
    // `load`, not `networkidle`: Turnstile keeps the network busy on
    // /register and /suggest-event. The settle below lets the async third-party
    // loaders (gtag, beacon, Turnstile) run so their violations would surface.
    const res = await page.goto(path, { waitUntil: "load" });
    expect(res, path).not.toBeNull();
    await page.waitForTimeout(3000);

    // The document that rendered (after any signed-out redirect) carries the
    // nonce policy, and every <script> in it carries that nonce.
    const csp = (await res!.allHeaders())["content-security-policy"] ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, `no nonce in CSP for ${page.url()}: ${csp}`).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
    expect(csp.split(";").find((d) => d.trim().startsWith("script-src"))).not.toContain(
      "'unsafe-inline'"
    );

    // Hydration happened — a blocked framework chunk would leave this false.
    await expect
      .poll(() => page.evaluate(() => typeof (window as { next?: unknown }).next === "object"))
      .toBe(true);

    // Turnstile (loaded by next/script, trusted via 'strict-dynamic') actually
    // ran wherever the page asked for it — only when a site key is built in.
    if ((await page.locator('script[src*="challenges.cloudflare.com/turnstile"]').count()) > 0) {
      await expect
        .poll(() => page.evaluate(() => typeof (window as { turnstile?: unknown }).turnstile))
        .toBe("object");
    }

    expect(await violations(), `CSP violations on ${page.url()}`).toEqual([]);
  });
}

test("the nonce changes between requests", async ({ request }) => {
  const nonceOf = async () =>
    /'nonce-([^']+)'/.exec((await request.get("/login")).headers()["content-security-policy"])?.[1];
  const a = await nonceOf();
  const b = await nonceOf();
  expect(a).toBeTruthy();
  expect(a).not.toBe(b);
});

test("a public page keeps the public policy (no nonce) and zero violations", async ({ page }) => {
  const violations = await collectViolations(page);
  const res = await page.goto("/about", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const csp = (await res!.allHeaders())["content-security-policy"] ?? "";
  expect(csp).not.toContain("nonce-");
  expect(csp).toContain("'unsafe-inline'");
  expect(await violations()).toEqual([]);
});
