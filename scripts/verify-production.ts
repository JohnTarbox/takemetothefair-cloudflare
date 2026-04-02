/**
 * Production verification script using Playwright.
 * Checks SEO, accessibility, visual features, and functionality.
 *
 * Usage: npx playwright test scripts/verify-production.ts
 *    Or: npx tsx scripts/verify-production.ts
 */

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "https://meetmeatthefair.com";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL" | "WARN";
  detail: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string) {
  results.push({ name, status: "PASS", detail });
}
function fail(name: string, detail: string) {
  results.push({ name, status: "FAIL", detail });
}
function warn(name: string, detail: string) {
  results.push({ name, status: "WARN", detail });
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1536, height: 864 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  });

  try {
    // ── Homepage Tests ─────────────────────────────────────────
    console.log("\n--- Homepage ---");
    const homepage = await context.newPage();
    await homepage.goto(BASE_URL, { waitUntil: "networkidle" });

    // og:image
    const ogImage = await homepage
      .locator('meta[property="og:image"]')
      .getAttribute("content");
    if (ogImage) {
      pass("og:image (homepage)", ogImage);
    } else {
      fail("og:image (homepage)", "Missing og:image meta tag");
    }

    // Canonical
    const canonical = await homepage
      .locator('link[rel="canonical"]')
      .getAttribute("href");
    if (canonical) {
      pass("Canonical URL (homepage)", canonical);
    } else {
      fail("Canonical URL (homepage)", "Missing canonical link tag");
    }

    // bg-white on html
    const htmlClass = await homepage.locator("html").getAttribute("class");
    if (htmlClass?.includes("bg-white")) {
      pass("bg-white on <html>", `class="${htmlClass}"`);
    } else {
      fail("bg-white on <html>", `class="${htmlClass}"`);
    }

    // Heading hierarchy
    const headings = await homepage.evaluate(() => {
      return Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map(
        (h) => ({
          level: parseInt(h.tagName[1]),
          text: h.textContent?.trim().substring(0, 50) || "",
        })
      );
    });
    const hasH1 = headings.some((h) => h.level === 1);
    const h3AfterH1 = headings.findIndex(
      (h, i) => h.level === 3 && i > 0 && headings[i - 1].level === 1
    );
    if (hasH1 && h3AfterH1 === -1) {
      pass(
        "Heading hierarchy (homepage)",
        headings.map((h) => `h${h.level}: ${h.text}`).join(" | ")
      );
    } else {
      fail(
        "Heading hierarchy (homepage)",
        `h3 follows h1 without h2 at index ${h3AfterH1}`
      );
    }

    // Footer social links
    const fbLink = await homepage
      .locator('a[href*="facebook.com/meetmeatthefair"]')
      .count();
    const igLink = await homepage
      .locator('a[href*="instagram.com/meetmeatthefair"]')
      .count();
    if (fbLink > 0 && igLink > 0) {
      pass("Footer social links", `Facebook: ${fbLink}, Instagram: ${igLink}`);
    } else {
      fail("Footer social links", `Facebook: ${fbLink}, Instagram: ${igLink}`);
    }

    // Footer social links have aria-labels
    const fbLabel = await homepage
      .locator('a[href*="facebook.com"] [aria-label], a[aria-label*="Facebook"]')
      .count();
    const igLabel = await homepage
      .locator('a[href*="instagram.com"] [aria-label], a[aria-label*="Instagram"]')
      .count();
    if (fbLabel > 0 || igLabel > 0) {
      pass("Social links aria-labels", "Present");
    } else {
      warn("Social links aria-labels", "Consider adding aria-label for accessibility");
    }

    await homepage.close();

    // ── Events Page Tests ──────────────────────────────────────
    console.log("--- Events Page ---");
    const eventsPage = await context.newPage();
    await eventsPage.goto(`${BASE_URL}/events`, { waitUntil: "networkidle" });

    // aria-current on active nav
    const ariaCurrent = await eventsPage
      .locator('a[href="/events"][aria-current="page"]')
      .count();
    if (ariaCurrent > 0) {
      pass("aria-current on Events nav", `Found ${ariaCurrent} link(s)`);
    } else {
      fail("aria-current on Events nav", "No aria-current='page' on Events link");
    }

    // Active nav link styling (blue)
    const eventsLinkClass = await eventsPage
      .locator('nav a[href="/events"]')
      .first()
      .getAttribute("class");
    if (eventsLinkClass?.includes("text-blue-600")) {
      pass("Active nav link styling", "text-blue-600 applied");
    } else {
      fail("Active nav link styling", `class="${eventsLinkClass}"`);
    }

    // Inactive nav links should NOT have blue
    const venuesLinkClass = await eventsPage
      .locator('nav a[href="/venues"]')
      .first()
      .getAttribute("class");
    if (venuesLinkClass?.includes("text-gray-600")) {
      pass("Inactive nav link styling", "text-gray-600 on Venues link");
    } else {
      warn("Inactive nav link styling", `class="${venuesLinkClass}"`);
    }

    // Event card category colors
    const categoryBadges = await eventsPage.evaluate(() => {
      const badges = document.querySelectorAll(
        ".rounded-full.text-xs.font-medium"
      );
      const classes = new Set<string>();
      badges.forEach((b) => {
        const cl = b.className;
        if (cl.includes("bg-blue-100")) classes.add("blue");
        if (cl.includes("bg-purple-100")) classes.add("purple");
        if (cl.includes("bg-amber-100")) classes.add("amber");
        if (cl.includes("bg-green-100")) classes.add("green");
        if (cl.includes("bg-gray-100")) classes.add("gray");
      });
      return Array.from(classes);
    });
    if (categoryBadges.length > 1) {
      pass("Event card category colors", categoryBadges.join(", "));
    } else {
      warn("Event card category colors", `Only found: ${categoryBadges.join(", ") || "none"}`);
    }

    // No internal tags visible
    const internalTags = await eventsPage
      .locator('text="#imported"')
      .count();
    const sourceTags = await eventsPage
      .locator('text="#fairsandfestivals"')
      .count();
    if (internalTags === 0 && sourceTags === 0) {
      pass("No internal tags on events page", "Clean");
    } else {
      fail("Internal tags visible", `#imported: ${internalTags}, #fairsandfestivals: ${sourceTags}`);
    }

    await eventsPage.close();

    // ── Venues Page Tests ──────────────────────────────────────
    console.log("--- Venues Page ---");
    const venuesPage = await context.newPage();
    await venuesPage.goto(`${BASE_URL}/venues`, { waitUntil: "networkidle" });

    // Venue card state colors
    const stateColors = await venuesPage.evaluate(() => {
      const cards = document.querySelectorAll(".aspect-video");
      const colors = new Set<string>();
      cards.forEach((c) => {
        const cl = c.className;
        if (cl.includes("bg-blue-50")) colors.add("ME/blue");
        if (cl.includes("bg-green-50")) colors.add("VT/green");
        if (cl.includes("bg-amber-50")) colors.add("NH/amber");
        if (cl.includes("bg-purple-50")) colors.add("MA/purple");
        if (cl.includes("bg-rose-50")) colors.add("CT/rose");
        if (cl.includes("bg-cyan-50")) colors.add("RI/cyan");
        if (cl.includes("bg-gray-100")) colors.add("default/gray");
      });
      return Array.from(colors);
    });
    if (stateColors.length > 1) {
      pass("Venue card state colors", stateColors.join(", "));
    } else {
      fail("Venue card state colors", `Only found: ${stateColors.join(", ") || "none"}`);
    }

    // State badges on venue cards
    const stateBadges = await venuesPage.evaluate(() => {
      const badges = document.querySelectorAll(".absolute.top-3.left-3 span");
      const states = new Set<string>();
      badges.forEach((b) => {
        const text = b.textContent?.trim();
        if (text && text.length === 2) states.add(text);
      });
      return Array.from(states);
    });
    if (stateBadges.length > 0) {
      pass("Venue state badges", stateBadges.join(", "));
    } else {
      warn("Venue state badges", "No state badges found");
    }

    await venuesPage.close();

    // ── Event Detail Page Tests ────────────────────────────────
    console.log("--- Event Detail Page ---");
    const detailPage = await context.newPage();
    await detailPage.goto(
      `${BASE_URL}/events/2026-orono-easter-craft-and-vendor-fair`,
      { waitUntil: "networkidle" }
    );

    // No internal tags on detail page
    const detailInternalTags = await detailPage.evaluate(() => {
      const allText = document.body.innerText;
      const issues: string[] = [];
      if (allText.includes("#imported")) issues.push("#imported");
      if (allText.includes("#fairsandfestivals")) issues.push("#fairsandfestivals");
      if (allText.includes("#url-import")) issues.push("#url-import");
      if (allText.includes("#community-suggestion")) issues.push("#community-suggestion");
      if (allText.includes("#vendor-submission")) issues.push("#vendor-submission");
      return issues;
    });
    if (detailInternalTags.length === 0) {
      pass("No internal tags on detail page", "Clean");
    } else {
      fail("Internal tags on detail page", detailInternalTags.join(", "));
    }

    // Description not truncated
    const description = await detailPage.evaluate(() => {
      const desc = document.querySelector(".whitespace-pre-wrap");
      return desc?.textContent?.trim() || "";
    });
    if (description && !description.endsWith("...")) {
      pass("Description not truncated", `${description.substring(0, 80)}...`);
    } else if (description.endsWith("...")) {
      fail("Description truncated", `Ends with "...": ${description.substring(description.length - 40)}`);
    } else {
      warn("Description check", "Could not find description element");
    }

    // Category badge colors on detail page
    const detailBadgeColors = await detailPage.evaluate(() => {
      const badges = document.querySelectorAll(
        ".rounded-full.text-xs.font-medium"
      );
      const colors: string[] = [];
      badges.forEach((b) => {
        const cl = b.className;
        const text = b.textContent?.trim();
        if (text && !["Featured", "Tentative", "Verified"].includes(text)) {
          if (cl.includes("bg-blue-100")) colors.push(`${text}=blue`);
          else if (cl.includes("bg-purple-100")) colors.push(`${text}=purple`);
          else if (cl.includes("bg-amber-100")) colors.push(`${text}=amber`);
          else if (cl.includes("bg-gray-100")) colors.push(`${text}=gray`);
          else colors.push(`${text}=other`);
        }
      });
      return colors;
    });
    if (detailBadgeColors.length > 0) {
      pass("Detail page category colors", detailBadgeColors.join(", "));
    } else {
      warn("Detail page category colors", "No category badges found");
    }

    await detailPage.close();

    // ── Scroll Shadow Test ─────────────────────────────────────
    console.log("--- Scroll Shadow ---");
    const scrollPage = await context.newPage();
    await scrollPage.goto(BASE_URL, { waitUntil: "networkidle" });

    // Check header before scroll
    const headerBefore = await scrollPage
      .locator("header")
      .first()
      .getAttribute("class");
    const hadShadowBefore = headerBefore?.includes("shadow-sm");

    // Scroll down
    await scrollPage.evaluate(() => window.scrollTo(0, 200));
    await scrollPage.waitForTimeout(300);

    const headerAfter = await scrollPage
      .locator("header")
      .first()
      .getAttribute("class");
    const hasShadowAfter = headerAfter?.includes("shadow-sm");

    if (!hadShadowBefore && hasShadowAfter) {
      pass("Nav shadow on scroll", "Shadow appears after scrolling");
    } else if (hasShadowAfter) {
      warn("Nav shadow on scroll", "Shadow present but was also present before scroll");
    } else {
      fail("Nav shadow on scroll", `Before: ${hadShadowBefore}, After: ${hasShadowAfter}`);
    }

    await scrollPage.close();
  } finally {
    await browser.close();
  }

  // ── Print Results ──────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("PRODUCTION VERIFICATION RESULTS");
  console.log("=".repeat(70));

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;

  for (const r of results) {
    const icon =
      r.status === "PASS" ? "OK" : r.status === "FAIL" ? "FAIL" : "WARN";
    console.log(`  [${icon}] ${r.name}`);
    console.log(`        ${r.detail}`);
  }

  console.log("=".repeat(70));
  console.log(`  ${passed} passed, ${failed} failed, ${warned} warnings`);
  console.log("=".repeat(70));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
