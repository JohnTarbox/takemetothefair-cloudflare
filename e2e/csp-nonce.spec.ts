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

/**
 * OPE-1410 — is a console CSP block about OUR document's policy?
 *
 * The Turnstile iframe (challenges.cloudflare.com) ships its own CSP, whose
 * `connect-src` lists *.challenges.cloudflare.com hosts and blocks `data:`.
 * Chromium forwards that frame's console output to `page.on("console")`, so
 * against prod with real keys /register and /suggest-event "failed" on a
 * policy we neither send nor control. A message counts as ours when:
 *   - it quotes a directive (`directive: "connect-src …"`, Firefox `“…”`)
 *     that appears verbatim in the policy our document was served with; or
 *   - it quotes no directive and was emitted by a document on our origin.
 * A foreign-origin frame quoting a directive that is not in our policy, or
 * quoting none at all, is that frame's own policy — ignored.
 *
 * `securitypolicyviolation` events are NOT filtered: the init-script listener
 * runs in our top document, where only our policy can fire.
 */
function isOurCspMessage(args: {
  text: string;
  sourceUrl: string | undefined;
  pageOrigin: string;
  ourPolicy: string;
}): boolean {
  const quoted = /directive:?\s*["“]([^"”]+)["”]/i.exec(args.text)?.[1]?.trim();
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const ourDirectives = args.ourPolicy.split(";").map(norm).filter(Boolean);
  if (quoted) return ourDirectives.includes(norm(quoted));
  let sourceOrigin = "";
  try {
    sourceOrigin = args.sourceUrl ? new URL(args.sourceUrl).origin : "";
  } catch {
    sourceOrigin = "";
  }
  // No source URL → we can't attribute it elsewhere; count it (fail closed).
  return sourceOrigin === "" || sourceOrigin === args.pageOrigin;
}

async function collectViolations(page: Page): Promise<() => Promise<string[]>> {
  const consoleErrors: { text: string; sourceUrl: string | undefined }[] = [];
  // The policy of the top-level document that actually rendered (the last
  // main-frame navigation response, i.e. after any signed-out redirect).
  let ourPolicy = "";
  page.on("response", (res) => {
    const req = res.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      const csp = res.headers()["content-security-policy"];
      if (csp !== undefined) ourPolicy = csp;
    }
  });
  page.on("console", (msg) => {
    const text = msg.text();
    // Only BLOCKS count. Firefox also WARNS "Ignoring 'self' within
    // script-src: 'strict-dynamic' specified" for the CSP2 fallback sources we
    // keep on purpose, and about unknown directives in Turnstile's own iframe
    // policy — neither blocks anything on our page.
    if (/Content[ -]Security[ -]Policy/i.test(text) && /blocked|refused/i.test(text))
      consoleErrors.push({ text, sourceUrl: msg.location().url || undefined });
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
    const pageOrigin = new URL(page.url()).origin;
    const ours = consoleErrors
      .filter((m) => isOurCspMessage({ ...m, pageOrigin, ourPolicy }))
      .map((m) => `console: ${m.text}`);
    return [...events, ...ours];
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

test("the console filter drops Turnstile's own policy and keeps ours (OPE-1410)", () => {
  const ourPolicy =
    "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; connect-src 'self' https://challenges.cloudflare.com";
  const pageOrigin = "https://meetmeatthefair.com";
  const turnstileFrame =
    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/normal";
  // Turnstile iframe's own connect-src — verbatim message shapes from prod.
  expect(
    isOurCspMessage({
      text: `Connecting to 'data:,' violates the following Content Security Policy directive: "connect-src 'self' https://hagen.challenges.cloudflare.com https://dnstest.dev". The action has been blocked.`,
      sourceUrl: turnstileFrame,
      pageOrigin,
      ourPolicy,
    })
  ).toBe(false);
  expect(
    isOurCspMessage({
      text: "Fetch API cannot load data:,. Refused to connect because it violates the document's Content Security Policy.",
      sourceUrl: turnstileFrame,
      pageOrigin,
      ourPolicy,
    })
  ).toBe(false);
  // Our directive → counts.
  expect(
    isOurCspMessage({
      text: `Refused to execute inline script because it violates the following Content Security Policy directive: "script-src 'self' 'nonce-abc' 'strict-dynamic'". Either the 'unsafe-inline' keyword is required.`,
      sourceUrl: `${pageOrigin}/register`,
      pageOrigin,
      ourPolicy,
    })
  ).toBe(true);
  // No directive quoted, emitted by our document (or unattributed) → counts.
  expect(
    isOurCspMessage({
      text: "Fetch API cannot load data:,. Refused to connect because it violates the document's Content Security Policy.",
      sourceUrl: `${pageOrigin}/register`,
      pageOrigin,
      ourPolicy,
    })
  ).toBe(true);
  expect(
    isOurCspMessage({
      text: "Refused to load because it violates the document's Content Security Policy.",
      sourceUrl: undefined,
      pageOrigin,
      ourPolicy,
    })
  ).toBe(true);
});
