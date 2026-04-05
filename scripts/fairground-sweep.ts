/**
 * Fairground Sweep — Comprehensive Production Test Suite
 *
 * Tests SEO health, link integrity, API endpoints, content rendering,
 * functional checks, error handling, and performance baselines.
 *
 * Usage: npx tsx scripts/fairground-sweep.ts
 *    Or: npm run test:sweep
 *
 * Set BASE_URL env var to test a different environment:
 *   BASE_URL=https://preview.example.com npx tsx scripts/fairground-sweep.ts
 */

import { chromium, type BrowserContext, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL || "https://meetmeatthefair.com";

// ── Result Infrastructure ────────────────────────────────────────

interface TestResult {
  category: string;
  name: string;
  status: "PASS" | "FAIL" | "WARN";
  detail: string;
}

const results: TestResult[] = [];

function pass(category: string, name: string, detail: string) {
  results.push({ category, name, status: "PASS", detail });
  console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`);
}
function fail(category: string, name: string, detail: string) {
  results.push({ category, name, status: "FAIL", detail });
  console.log(`  \x1b[31m[FAIL]\x1b[0m ${name} — ${detail}`);
}
function warn(category: string, name: string, detail: string) {
  results.push({ category, name, status: "WARN", detail });
  console.log(`  \x1b[33m[WARN]\x1b[0m ${name} — ${detail}`);
}

// ── Sitemap Discovery ────────────────────────────────────────────

interface DiscoveredSlugs {
  events: string[];
  venues: string[];
  vendors: string[];
  blogPosts: string[];
  allUrls: string[];
}

function sampleArray<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return [...arr];
  const result: T[] = [arr[0], arr[arr.length - 1]];
  const remaining = count - 2;
  const middle = arr.slice(1, -1);
  for (let i = 0; i < remaining && middle.length > 0; i++) {
    const idx = Math.floor(Math.random() * middle.length);
    result.push(middle.splice(idx, 1)[0]);
  }
  return result;
}

async function parseSitemap(): Promise<DiscoveredSlugs> {
  const res = await fetch(`${BASE_URL}/sitemap.xml`);
  const xml = await res.text();
  const urls: string[] = [];
  const regex = /<loc>([^<]+)<\/loc>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    urls.push(match[1]);
  }

  const events = urls.filter(
    (u) => u.match(/\/events\/[^/]+$/) && !u.includes("/events/past") &&
           !u.includes("/events/maine") && !u.includes("/events/vermont") &&
           !u.includes("/events/new-hampshire") && !u.includes("/events/massachusetts")
  );
  const venues = urls.filter((u) => u.match(/\/venues\/[^/]+$/));
  const vendors = urls.filter((u) => u.match(/\/vendors\/[^/]+$/));
  const blogPosts = urls.filter((u) => u.match(/\/blog\/[^/]+$/) && !u.includes("/blog/feed"));

  return {
    events: sampleArray(events, 5),
    venues: sampleArray(venues, 3),
    vendors: sampleArray(vendors, 3),
    blogPosts: sampleArray(blogPosts, 2),
    allUrls: urls,
  };
}

// ── Helper Functions ─────────────────────────────────────────────

function urlToPath(url: string): string {
  return url.replace(BASE_URL, "") || "/";
}

async function getMetaContent(page: Page, selector: string): Promise<string | null> {
  return page.locator(selector).first().getAttribute("content").catch(() => null);
}

async function headCheck(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return res.status;
  } catch {
    return 0;
  }
}

// ── 1. SEO Health ────────────────────────────────────────────────

async function runSeoHealth(context: BrowserContext, slugs: DiscoveredSlugs) {
  console.log("\n── SEO Health ──────────────────────────────────────");
  const cat = "SEO Health";

  // JSON-LD validation on sampled event pages
  for (const eventUrl of slugs.events.slice(0, 3)) {
    const path = urlToPath(eventUrl);
    const page = await context.newPage();
    try {
      await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

      const jsonLdText = await page.locator('script[type="application/ld+json"]').first().textContent().catch(() => null);
      if (!jsonLdText) {
        fail(cat, `JSON-LD present (${path})`, "No JSON-LD script tag found");
        continue;
      }

      let schema: Record<string, unknown>;
      try {
        schema = JSON.parse(jsonLdText);
      } catch {
        fail(cat, `JSON-LD valid JSON (${path})`, "Failed to parse JSON-LD");
        continue;
      }

      // Required fields
      const hasContext = schema["@context"] === "https://schema.org";
      const hasType = typeof schema["@type"] === "string";
      const hasName = typeof schema.name === "string" && (schema.name as string).length > 0;
      const hasUrl = typeof schema.url === "string";
      const hasDatesOrPostponed = schema.startDate || schema.eventStatus === "https://schema.org/EventPostponed";

      if (hasContext && hasType && hasName && hasUrl && hasDatesOrPostponed) {
        pass(cat, `JSON-LD required fields (${path})`, `@type=${schema["@type"]}, name="${(schema.name as string).slice(0, 40)}"`);
      } else {
        const missing = [];
        if (!hasContext) missing.push("@context");
        if (!hasType) missing.push("@type");
        if (!hasName) missing.push("name");
        if (!hasUrl) missing.push("url");
        if (!hasDatesOrPostponed) missing.push("startDate/eventStatus");
        fail(cat, `JSON-LD required fields (${path})`, `Missing: ${missing.join(", ")}`);
      }

      // Image should not be generic fallback
      const image = schema.image as string;
      if (image && image.includes("og-default.png")) {
        fail(cat, `JSON-LD image not generic (${path})`, "Using og-default.png fallback");
      } else if (image) {
        pass(cat, `JSON-LD image not generic (${path})`, image.slice(0, 60));
      }

      // Organizer check
      const organizer = schema.organizer as Record<string, unknown> | undefined;
      if (organizer && organizer.name === "Meet Me at the Fair") {
        warn(cat, `JSON-LD organizer (${path})`, "Organizer is 'Meet Me at the Fair' — should be actual promoter or omitted");
      }

      // Offers validFrom
      const offers = schema.offers as Record<string, unknown> | undefined;
      if (offers && !offers.validFrom) {
        warn(cat, `JSON-LD offers.validFrom (${path})`, "Missing validFrom in offers");
      }
    } catch (e) {
      fail(cat, `JSON-LD check (${path})`, `Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await page.close();
    }
  }

  // Meta description length checks
  const descPages = [
    slugs.events[0],
    slugs.venues[0],
    slugs.vendors[0],
  ].filter(Boolean);

  for (const url of descPages) {
    const path = urlToPath(url);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const desc = await getMetaContent(page, 'meta[name="description"]');
      if (!desc) {
        fail(cat, `Meta description present (${path})`, "Missing meta description");
      } else if (desc.length >= 120 && desc.length <= 160) {
        pass(cat, `Meta description length (${path})`, `${desc.length} chars`);
      } else if (desc.length >= 100 && desc.length <= 170) {
        warn(cat, `Meta description length (${path})`, `${desc.length} chars (ideal: 120-160)`);
      } else {
        fail(cat, `Meta description length (${path})`, `${desc.length} chars — outside 100-170 range`);
      }
    } finally {
      await page.close();
    }
  }

  // Canonical URL, OG tags, and H1 checks on key pages
  const seoPages = [
    BASE_URL,
    `${BASE_URL}/events`,
    `${BASE_URL}/venues`,
    slugs.events[0],
    slugs.venues[0],
    slugs.vendors[0],
  ].filter(Boolean);

  for (const url of seoPages) {
    const path = urlToPath(url);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      // Canonical
      const canonical = await page.locator('link[rel="canonical"]').first().getAttribute("href").catch(() => null);
      if (canonical && (canonical === url || canonical === url + "/")) {
        pass(cat, `Canonical URL (${path})`, canonical);
      } else if (canonical) {
        warn(cat, `Canonical URL (${path})`, `Mismatch: canonical=${canonical}, page=${url}`);
      } else {
        fail(cat, `Canonical URL (${path})`, "Missing canonical link");
      }

      // OG tags
      const ogTitle = await getMetaContent(page, 'meta[property="og:title"]');
      const ogDesc = await getMetaContent(page, 'meta[property="og:description"]');
      const ogImage = await getMetaContent(page, 'meta[property="og:image"]');
      const ogUrl = await getMetaContent(page, 'meta[property="og:url"]');
      const missingOg = [];
      if (!ogTitle) missingOg.push("og:title");
      if (!ogDesc) missingOg.push("og:description");
      if (!ogImage) missingOg.push("og:image");
      if (!ogUrl) missingOg.push("og:url");
      if (missingOg.length === 0) {
        pass(cat, `OG tags complete (${path})`, "All 4 OG tags present");
      } else {
        fail(cat, `OG tags complete (${path})`, `Missing: ${missingOg.join(", ")}`);
      }

      // Single H1
      const h1Count = await page.locator("h1").count();
      if (h1Count === 1) {
        pass(cat, `Single H1 (${path})`, "Exactly 1 h1 tag");
      } else if (h1Count === 0) {
        fail(cat, `Single H1 (${path})`, "No h1 tag found");
      } else {
        warn(cat, `Single H1 (${path})`, `${h1Count} h1 tags found`);
      }
    } finally {
      await page.close();
    }
  }

  // Sitemap spot-check
  const sitemapSample = sampleArray(slugs.allUrls, 10);
  let sitemapOk = 0;
  let sitemapFail = 0;
  for (const url of sitemapSample) {
    const status = await headCheck(url);
    if (status === 200) {
      sitemapOk++;
    } else {
      sitemapFail++;
      fail(cat, "Sitemap URL reachable", `${urlToPath(url)} returned ${status}`);
    }
  }
  if (sitemapFail === 0) {
    pass(cat, `Sitemap spot-check (${sitemapSample.length} URLs)`, "All returned 200");
  }
}

// ── 2. API Health ────────────────────────────────────────────────

async function runApiHealth() {
  console.log("\n── API Health ──────────────────────────────────────");
  const cat = "API Health";

  // Health endpoint
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    const contentType = res.headers.get("content-type") || "";
    if (res.status === 200 && contentType.includes("application/json")) {
      const body = await res.json() as { status: string; checks?: { database?: { latencyMs?: number } } };
      if (body.status === "healthy" || body.status === "degraded") {
        pass(cat, "/api/health", `status=${body.status}, db=${body.checks?.database?.latencyMs}ms`);
      } else {
        warn(cat, "/api/health", `Unexpected status: ${body.status}`);
      }
    } else {
      fail(cat, "/api/health", `HTTP ${res.status}, content-type: ${contentType}`);
    }
  } catch (e) {
    fail(cat, "/api/health", `Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Search endpoint
  try {
    const res = await fetch(`${BASE_URL}/api/search?q=fair`);
    if (res.status === 200) {
      const body = await res.json() as { events?: unknown[]; venues?: unknown[]; vendors?: unknown[] };
      const totalResults = (body.events?.length || 0) + (body.venues?.length || 0) + (body.vendors?.length || 0);
      if (totalResults > 0) {
        pass(cat, "/api/search?q=fair", `${totalResults} results returned`);
      } else {
        warn(cat, "/api/search?q=fair", "No results for 'fair' — possible data issue");
      }
    } else {
      fail(cat, "/api/search?q=fair", `HTTP ${res.status}`);
    }
  } catch (e) {
    fail(cat, "/api/search?q=fair", `Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Protected routes should return 401
  // Note: /api/favorites GET returns empty array for unauthenticated users (by design)
  const protectedRoutes = [
    "/api/admin/events",
    "/api/vendor/profile",
  ];
  for (const route of protectedRoutes) {
    try {
      const res = await fetch(`${BASE_URL}${route}`);
      if (res.status === 401) {
        pass(cat, `${route} returns 401`, "Correctly requires auth");
      } else if (res.status === 403) {
        pass(cat, `${route} returns 403`, "Correctly requires auth");
      } else {
        fail(cat, `${route} auth guard`, `Expected 401/403, got ${res.status}`);
      }
    } catch (e) {
      fail(cat, `${route} auth guard`, `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── 3. Link Integrity ────────────────────────────────────────────

async function runLinkIntegrity(context: BrowserContext, slugs: DiscoveredSlugs) {
  console.log("\n── Link Integrity ──────────────────────────────────");
  const cat = "Link Integrity";

  // Footer links
  const homepage = await context.newPage();
  await homepage.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });

  const footerLinks = await homepage.locator("footer a").evaluateAll((els) =>
    els.map((el) => el.getAttribute("href")).filter((h): h is string => !!h)
  );

  const internalFooterLinks = footerLinks.filter((h) => h.startsWith("/"));
  let footerOk = 0;
  let footerFail = 0;
  for (const href of internalFooterLinks) {
    const status = await headCheck(`${BASE_URL}${href}`);
    if (status === 200) {
      footerOk++;
    } else {
      footerFail++;
      fail(cat, `Footer link: ${href}`, `HTTP ${status}`);
    }
  }
  if (footerFail === 0) {
    pass(cat, `Footer links (${internalFooterLinks.length} internal)`, "All returned 200");
  }

  // Check /events/past is linked from footer
  const pastInFooter = footerLinks.some((h) => h === "/events/past");
  if (pastInFooter) {
    pass(cat, "/events/past in footer", "Link found");
  } else {
    fail(cat, "/events/past in footer", "Not linked from footer");
  }
  await homepage.close();

  // Check /events/past is linked from /events page
  const eventsPage = await context.newPage();
  await eventsPage.goto(`${BASE_URL}/events`, { waitUntil: "domcontentloaded", timeout: 15000 });
  const pastOnEventsPage = await eventsPage.locator('a[href="/events/past"]').count();
  if (pastOnEventsPage > 0) {
    pass(cat, "/events/past linked from /events", "Link found");
  } else {
    fail(cat, "/events/past linked from /events", "Not linked from events listing");
  }
  await eventsPage.close();

  // Internal links on a sampled event detail page
  if (slugs.events[0]) {
    const detailPage = await context.newPage();
    const eventPath = urlToPath(slugs.events[0]);
    await detailPage.goto(slugs.events[0], { waitUntil: "domcontentloaded", timeout: 15000 });

    const detailLinks = await detailPage.locator("main a").evaluateAll((els) =>
      els.map((el) => el.getAttribute("href")).filter((h): h is string => !!h && h.startsWith("/"))
    );

    const uniqueLinks = [...new Set(detailLinks)].slice(0, 15);
    let detailOk = 0;
    let detailFail = 0;
    for (const href of uniqueLinks) {
      const status = await headCheck(`${BASE_URL}${href}`);
      if (status === 200) {
        detailOk++;
      } else {
        detailFail++;
        fail(cat, `Detail page link: ${href}`, `HTTP ${status} (from ${eventPath})`);
      }
    }
    if (detailFail === 0) {
      pass(cat, `Event detail internal links (${uniqueLinks.length})`, `All returned 200 (${eventPath})`);
    }
    await detailPage.close();
  }
}

// ── 4. Content Validation ────────────────────────────────────────

async function runContentValidation(context: BrowserContext, slugs: DiscoveredSlugs) {
  console.log("\n── Content Validation ──────────────────────────────");
  const cat = "Content Validation";

  // Event detail pages
  for (const eventUrl of slugs.events.slice(0, 3)) {
    const path = urlToPath(eventUrl);
    const page = await context.newPage();
    try {
      await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      const h1 = await page.locator("h1").first().textContent().catch(() => null);
      if (h1 && h1.trim().length > 0) {
        pass(cat, `Event h1 (${path})`, h1.trim().slice(0, 50));
      } else {
        fail(cat, `Event h1 (${path})`, "No h1 or empty h1");
      }
    } finally {
      await page.close();
    }
  }

  // Venue detail pages
  for (const venueUrl of slugs.venues.slice(0, 2)) {
    const path = urlToPath(venueUrl);
    const page = await context.newPage();
    try {
      await page.goto(venueUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      const h1 = await page.locator("h1").first().textContent().catch(() => null);
      const hasLocation = await page.locator("text=/[A-Z]{2}/").first().isVisible().catch(() => false);
      if (h1 && h1.trim().length > 0) {
        pass(cat, `Venue renders (${path})`, `h1="${h1.trim().slice(0, 40)}", location=${hasLocation}`);
      } else {
        fail(cat, `Venue renders (${path})`, "Missing h1");
      }
    } finally {
      await page.close();
    }
  }

  // Vendor detail pages
  for (const vendorUrl of slugs.vendors.slice(0, 2)) {
    const path = urlToPath(vendorUrl);
    const page = await context.newPage();
    try {
      await page.goto(vendorUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      const h1 = await page.locator("h1").first().textContent().catch(() => null);
      if (h1 && h1.trim().length > 0) {
        pass(cat, `Vendor renders (${path})`, h1.trim().slice(0, 50));
      } else {
        fail(cat, `Vendor renders (${path})`, "Missing h1");
      }
    } finally {
      await page.close();
    }
  }

  // Blog listing
  const blogPage = await context.newPage();
  try {
    await blogPage.goto(`${BASE_URL}/blog`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const blogH1 = await blogPage.locator("h1").first().textContent().catch(() => null);
    const blogLinks = await blogPage.locator('a[href^="/blog/"]').count();
    if (blogH1 && blogLinks > 0) {
      pass(cat, "Blog listing", `h1 present, ${blogLinks} post links`);
    } else if (blogH1) {
      warn(cat, "Blog listing", "h1 present but no blog post links found");
    } else {
      fail(cat, "Blog listing", "Missing h1");
    }
  } finally {
    await blogPage.close();
  }

  // Blog post detail
  if (slugs.blogPosts[0]) {
    const path = urlToPath(slugs.blogPosts[0]);
    const page = await context.newPage();
    try {
      await page.goto(slugs.blogPosts[0], { waitUntil: "domcontentloaded", timeout: 15000 });
      const h1 = await page.locator("h1").first().textContent().catch(() => null);
      const bodyLength = await page.evaluate(() => {
        const article = document.querySelector("article") || document.querySelector("main");
        return article?.textContent?.length || 0;
      });
      if (h1 && bodyLength > 100) {
        pass(cat, `Blog post (${path})`, `h1 present, body ${bodyLength} chars`);
      } else {
        warn(cat, `Blog post (${path})`, `h1=${!!h1}, body=${bodyLength} chars`);
      }
    } finally {
      await page.close();
    }
  }

  // RSS feed
  try {
    const res = await fetch(`${BASE_URL}/blog/feed.xml`);
    const body = await res.text();
    const isXml = body.trimStart().startsWith("<?xml") || body.trimStart().startsWith("<rss");
    const hasChannel = body.includes("<channel>");
    const hasItem = body.includes("<item>");
    if (res.status === 200 && isXml && hasChannel) {
      if (hasItem) {
        pass(cat, "RSS feed (/blog/feed.xml)", "Valid XML with channel and items");
      } else {
        warn(cat, "RSS feed (/blog/feed.xml)", "Valid XML but no items");
      }
    } else {
      fail(cat, "RSS feed (/blog/feed.xml)", `status=${res.status}, xml=${isXml}, channel=${hasChannel}`);
    }
  } catch (e) {
    fail(cat, "RSS feed (/blog/feed.xml)", `Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 5. Functional Checks ────────────────────────────────────────

async function runFunctionalChecks(context: BrowserContext, slugs: DiscoveredSlugs) {
  console.log("\n── Functional Checks ───────────────────────────────");
  const cat = "Functional Checks";

  // Search results page
  const searchPage = await context.newPage();
  try {
    const res = await searchPage.goto(`${BASE_URL}/search?q=fair`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const status = res?.status() || 0;
    const h1 = await searchPage.locator("h1").first().textContent().catch(() => null);
    if (status === 200 && h1) {
      pass(cat, "Search page renders", `h1="${h1.trim().slice(0, 40)}"`);
    } else {
      fail(cat, "Search page renders", `status=${status}, h1=${!!h1}`);
    }
  } finally {
    await searchPage.close();
  }

  // Events pagination
  const eventsPage = await context.newPage();
  try {
    await eventsPage.goto(`${BASE_URL}/events`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const nextLink = await eventsPage.locator('a:has-text("»")').first().getAttribute("href").catch(() => null);
    if (nextLink) {
      pass(cat, "Events pagination link exists", nextLink);

      // Navigate to page 2
      const page2Url = nextLink.startsWith("http") ? nextLink : `${BASE_URL}${nextLink}`;
      const page2Res = await eventsPage.goto(page2Url, { waitUntil: "domcontentloaded", timeout: 15000 });
      if (page2Res?.status() === 200) {
        pass(cat, "Events page 2 loads", "HTTP 200");
      } else {
        fail(cat, "Events page 2 loads", `status=${page2Res?.status()}`);
      }
    } else {
      warn(cat, "Events pagination link exists", "No next page link — may only have 1 page");
    }
  } finally {
    await eventsPage.close();
  }

  // State filter
  const mainePage = await context.newPage();
  try {
    const res = await mainePage.goto(`${BASE_URL}/events/maine`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const h1 = await mainePage.locator("h1").first().textContent().catch(() => null);
    if (res?.status() === 200 && h1 && h1.toLowerCase().includes("maine")) {
      pass(cat, "State filter (Maine)", `h1="${h1.trim().slice(0, 50)}"`);
    } else {
      fail(cat, "State filter (Maine)", `status=${res?.status()}, h1="${h1}"`);
    }
  } finally {
    await mainePage.close();
  }

  // Past events page
  const pastPage = await context.newPage();
  try {
    const res = await pastPage.goto(`${BASE_URL}/events/past`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const h1 = await pastPage.locator("h1").first().textContent().catch(() => null);
    if (res?.status() === 200 && h1) {
      pass(cat, "Past events page", `h1="${h1.trim().slice(0, 50)}"`);
    } else {
      fail(cat, "Past events page", `status=${res?.status()}, h1="${h1}"`);
    }
  } finally {
    await pastPage.close();
  }

  // Dynamic OG image
  if (slugs.events[0]) {
    const slug = slugs.events[0].split("/events/")[1];
    try {
      const res = await fetch(`${BASE_URL}/api/og?slug=${encodeURIComponent(slug)}`);
      const contentType = res.headers.get("content-type") || "";
      if (res.status === 200 && contentType.startsWith("image/")) {
        pass(cat, "Dynamic OG image", `${contentType} for slug=${slug}`);
      } else {
        fail(cat, "Dynamic OG image", `status=${res.status}, type=${contentType}`);
      }
    } catch (e) {
      fail(cat, "Dynamic OG image", `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── 6. Error Handling ────────────────────────────────────────────

async function runErrorHandling(context: BrowserContext) {
  console.log("\n── Error Handling ──────────────────────────────────");
  const cat = "Error Handling";

  const notFoundPaths = [
    "/this-page-does-not-exist-12345",
    "/events/nonexistent-event-slug-xyz-999",
    "/venues/nonexistent-venue-slug-xyz-999",
    "/vendors/nonexistent-vendor-slug-xyz-999",
  ];

  for (const path of notFoundPaths) {
    const page = await context.newPage();
    try {
      const res = await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded", timeout: 15000 });
      const status = res?.status() || 0;
      const bodyText = await page.locator("body").textContent().catch(() => "") || "";
      const hasErrorStack = bodyText.includes("Error:") && bodyText.includes("at ");
      // Cloudflare Pages edge runtime may return 200 with notFound() content
      const hasNotFoundContent = bodyText.toLowerCase().includes("not found") ||
                                  bodyText.toLowerCase().includes("404") ||
                                  bodyText.toLowerCase().includes("doesn't exist") ||
                                  bodyText.toLowerCase().includes("does not exist");

      if (hasErrorStack) {
        fail(cat, `Error handling ${path}`, "Page contains error stack trace — crashed");
      } else if (status === 404 || hasNotFoundContent) {
        pass(cat, `Not found ${path}`, `status=${status}, shows not-found content`);
      } else {
        fail(cat, `Not found ${path}`, `status=${status}, no not-found content — may render broken page`);
      }
    } finally {
      await page.close();
    }
  }

  // Malformed query params
  const malformedPage = await context.newPage();
  try {
    const res = await malformedPage.goto(
      `${BASE_URL}/events?page=abc&category=%3Cscript%3Ealert(1)%3C%2Fscript%3E`,
      { waitUntil: "domcontentloaded", timeout: 15000 }
    );
    const status = res?.status() || 0;
    if (status === 200) {
      pass(cat, "Malformed query params", "Page loads gracefully with bad params");
    } else {
      fail(cat, "Malformed query params", `Unexpected status ${status}`);
    }
  } finally {
    await malformedPage.close();
  }
}

// ── 7. Performance Baseline ──────────────────────────────────────

async function runPerformanceBaseline(context: BrowserContext, slugs: DiscoveredSlugs) {
  console.log("\n── Performance Baseline ────────────────────────────");
  const cat = "Performance";

  const perfPages = [
    { url: BASE_URL, label: "/" },
    { url: `${BASE_URL}/events`, label: "/events" },
    { url: `${BASE_URL}/venues`, label: "/venues" },
    { url: `${BASE_URL}/vendors`, label: "/vendors" },
  ];
  if (slugs.events[0]) {
    perfPages.push({ url: slugs.events[0], label: urlToPath(slugs.events[0]) });
  }

  for (const { url, label } of perfPages) {
    const page = await context.newPage();
    try {
      const start = Date.now();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const ttfb = Date.now() - start;
      if (ttfb < 2000) {
        pass(cat, `TTFB ${label}`, `${ttfb}ms`);
      } else if (ttfb < 3000) {
        warn(cat, `TTFB ${label}`, `${ttfb}ms (target: <2000ms)`);
      } else {
        fail(cat, `TTFB ${label}`, `${ttfb}ms (target: <2000ms)`);
      }
    } finally {
      await page.close();
    }
  }

  // Console errors check
  for (const url of [BASE_URL, `${BASE_URL}/events`]) {
    const label = urlToPath(url);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        // Ignore known benign messages
        if (!text.includes("favicon") && !text.includes("__nextjs")) {
          consoleErrors.push(text.slice(0, 100));
        }
      }
    });
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      if (consoleErrors.length === 0) {
        pass(cat, `No console errors (${label})`, "Clean console");
      } else {
        warn(cat, `Console errors (${label})`, `${consoleErrors.length}: ${consoleErrors[0]}`);
      }
    } finally {
      await page.close();
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("  FAIRGROUND SWEEP — Production Test Suite");
  console.log("  Target: " + BASE_URL);
  console.log("  Time:   " + new Date().toISOString());
  console.log("=".repeat(70));

  const startTime = Date.now();

  // Discover content from sitemap
  console.log("\nDiscovering content from sitemap...");
  const slugs = await parseSitemap();
  console.log(`  Found: ${slugs.events.length} event samples, ${slugs.venues.length} venue samples, ${slugs.vendors.length} vendor samples, ${slugs.blogPosts.length} blog samples`);
  console.log(`  Total sitemap URLs: ${slugs.allUrls.length}`);

  // Launch browser
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "FairgroundSweep/1.0 (Production Test Suite)",
  });

  try {
    await runSeoHealth(context, slugs);
    await runApiHealth();
    await runLinkIntegrity(context, slugs);
    await runContentValidation(context, slugs);
    await runFunctionalChecks(context, slugs);
    await runErrorHandling(context);
    await runPerformanceBaseline(context, slugs);
  } finally {
    await browser.close();
  }

  // Print grouped summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;

  console.log("\n" + "=".repeat(70));
  console.log("  FAIRGROUND SWEEP SUMMARY");
  console.log("=".repeat(70));

  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catPassed = catResults.filter((r) => r.status === "PASS").length;
    const catFailed = catResults.filter((r) => r.status === "FAIL").length;
    const catWarned = catResults.filter((r) => r.status === "WARN").length;
    const statusIcon = catFailed > 0 ? "\x1b[31m✗\x1b[0m" : catWarned > 0 ? "\x1b[33m!\x1b[0m" : "\x1b[32m✓\x1b[0m";
    console.log(`  ${statusIcon} ${cat}: ${catPassed} passed, ${catFailed} failed, ${catWarned} warnings`);
  }

  console.log("\n  " + "-".repeat(50));
  const summaryColor = failed > 0 ? "\x1b[31m" : warned > 0 ? "\x1b[33m" : "\x1b[32m";
  console.log(`  ${summaryColor}Total: ${passed} passed, ${failed} failed, ${warned} warnings\x1b[0m`);
  console.log(`  Duration: ${elapsed}s`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fairground Sweep failed:", err);
  process.exit(1);
});
