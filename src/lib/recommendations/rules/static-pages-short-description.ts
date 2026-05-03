/**
 * Static-page meta-description audit. Approximates Bing Site Scan's "meta
 * descriptions too short" finding for the routes that AREN'T backed by D1
 * data — i.e. the pages whose metadata lives in code rather than columns.
 *
 * Approach: fetch each page over the public URL, extract the
 * <meta name="description"> content with a simple regex, and flag pages
 * where the description is missing or under SHORT_THRESHOLD chars.
 *
 * Why fetch over the public URL instead of importing from each route's
 * generateMetadata():
 *   - generateMetadata() is async and consumes search params / draft mode etc.;
 *     can't safely call it from this runtime context without recreating the
 *     Next.js request.
 *   - Fetching gives us the same HTML the user (and Bingbot) sees.
 *
 * Cost: ~200ms per page. 8 pages → ~1.6s; we run them in parallel so wall time
 * is ~250ms. Acceptable on a 15-min cached Recommendations scan.
 */

import type { ItemMatch, RuleDefinition } from "../engine";

const SHORT_THRESHOLD = 70;
const SITE_BASE_URL = "https://meetmeatthefair.com";
const FETCH_TIMEOUT_MS = 5000;

// Curated list of public static pages worth auditing. Excludes:
// - auth pages (/login, /register, /forgot-password) — meta less SEO-relevant
// - admin / dashboard / vendor / promoter portals — non-public
// - dynamic listing pages (/events, /events/maine, etc.) — already produce
//   data-driven meta; if their copy is short, the issue is in the template
//   and a single fix would correct all of them.
const STATIC_PAGES = [
  { path: "/", label: "Home" },
  { path: "/about", label: "About" },
  { path: "/contact", label: "Contact" },
  { path: "/faq", label: "FAQ" },
  { path: "/privacy", label: "Privacy" },
  { path: "/terms", label: "Terms" },
  { path: "/suggest-event", label: "Suggest Event" },
  { path: "/tools/inventory-calculator", label: "Inventory Calculator" },
];

const META_DESCRIPTION_RE = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i;

async function fetchMetaDescription(
  path: string
): Promise<{ length: number; status: "ok" | "missing" | "fetch_failed"; httpStatus?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SITE_BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { "User-Agent": "MMATF-MetaCheck/1.0 (admin/analytics scan)" },
    });
    if (!res.ok) {
      return { length: -1, status: "fetch_failed", httpStatus: res.status };
    }
    const html = await res.text();
    const m = html.match(META_DESCRIPTION_RE);
    if (!m) return { length: 0, status: "missing" };
    return { length: m[1].length, status: "ok" };
  } catch {
    return { length: -1, status: "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export const staticPagesShortDescriptionRule: RuleDefinition = {
  ruleKey: "static_pages_short_description",
  title: "Static pages with missing or short meta descriptions",
  rationaleTemplate:
    "{n} static pages have meta descriptions shorter than 70 chars (or missing entirely). Fix in the route's generateMetadata() / metadata export.",
  severity: "yellow",
  category: "seo",
  async run(): Promise<ItemMatch[]> {
    const results = await Promise.all(
      STATIC_PAGES.map(async (page) => {
        const meta = await fetchMetaDescription(page.path);
        return { page, meta };
      })
    );

    return results
      .filter(
        (r) =>
          r.meta.status === "missing" || (r.meta.status === "ok" && r.meta.length < SHORT_THRESHOLD)
      )
      .map((r) => ({
        targetType: "static_page",
        targetId: r.page.path,
        payload: {
          path: r.page.path,
          label: r.page.label,
          descriptionLength: r.meta.length,
          status: r.meta.status,
        },
      }));
  },
};
