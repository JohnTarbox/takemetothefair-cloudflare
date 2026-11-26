/**
 * OPE-1602 — every admin page is reachable from the sidebar, or is listed here
 * with the reason it isn't. A new page.tsx with neither fails this test, which is
 * how 11 routes ended up with no way in.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminNavGroups } from "../admin-nav";
import { adminSections, findAdminSection } from "../admin-sections";

const ADMIN_ROOT = join(process.cwd(), "src/app/admin");

/** Reached from their parent page, or retired by OPE-1604, or dashboard-only. */
const NOT_IN_SIDEBAR: Record<string, string> = {
  "/admin/events/new": "button on Events",
  "/admin/events/calendar": "linked from Events",
  "/admin/promoters/new": "button on Promoters",
  "/admin/vendors/new": "button on Vendors",
  "/admin/venues/new": "button on Venues",
  "/admin/analytics/automation": "tab on Analytics",
  "/admin/analytics/ga4": "tab on Analytics",
  "/admin/stuck-urls": "link in the Analytics tab bar, beside Google",
  "/admin/analytics/page": "stray route, removed by OPE-1604",
  "/admin/backfill-source-domain": "retired by OPE-1604",
  "/admin/snap": "phone tool, linked from the dashboard on small screens",
  "/admin/duplicates/flags": "tab on Duplicates (OPE-1597)",
};

function adminRoutes(dir = ADMIN_ROOT, route = "/admin"): string[] {
  const routes: string[] = existsSync(join(dir, "page.tsx")) ? [route] : [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("[") || entry.startsWith("__")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routes.push(...adminRoutes(full, `${route}/${entry}`));
  }
  return routes;
}

const linked = adminNavGroups.flatMap((group) => group.items.map((item) => item.href));
/** The route a sidebar link lands on; "Search" is a tab of Analytics. */
const linkedRoutes = linked.map((href) => href.split("?")[0]);
const tabbed = adminSections.flatMap((section) => section.tabs.map((tab) => tab.href));
const reachable = new Set([...linkedRoutes, ...tabbed]);

describe("admin sidebar", () => {
  it("has the six groups, in order", () => {
    expect(adminNavGroups.map((group) => group.label)).toEqual([
      "Today",
      "Work queues",
      "Catalog",
      "Ingest",
      "Content & SEO",
      "System",
    ]);
  });

  it("links only to pages that exist, once each", () => {
    expect(linked.length).toBeGreaterThan(15);
    expect(new Set(linked).size).toBe(linked.length);
    const routes = new Set(adminRoutes());
    expect(linkedRoutes.filter((href) => !routes.has(href))).toEqual([]);
  });

  it("reaches every admin page, or says why not", () => {
    const routes = adminRoutes();
    // A positive landmark, so a walker that stops finding pages cannot pass.
    expect(routes.length).toBeGreaterThan(35);
    const unreachable = routes.filter((r) => !reachable.has(r) && !(r in NOT_IN_SIDEBAR));
    expect(unreachable).toEqual([]);
  });

  it("links Stuck URLs from the Analytics tab bar, which its exemption relies on", () => {
    const page = readFileSync(join(ADMIN_ROOT, "analytics/page.tsx"), "utf8");
    expect(page).toContain('href="/admin/stuck-urls"');
  });

  it("carries no exemption for a page that is gone or now linked", () => {
    const routes = new Set(adminRoutes());
    const stale = Object.keys(NOT_IN_SIDEBAR).filter((r) => !routes.has(r) || reachable.has(r));
    expect(stale).toEqual([]);
  });

  it("gives each merged section one sidebar entry, its first tab, and real pages", () => {
    expect(adminSections.length).toBe(5);
    const routes = new Set(adminRoutes());
    expect(tabbed.length).toBe(new Set(tabbed).size);
    expect(tabbed.filter((href) => !routes.has(href))).toEqual([]);
    for (const section of adminSections) {
      const [first, ...rest] = section.tabs.map((tab) => tab.href);
      expect(linked).toContain(first);
      expect(rest.filter((href) => linked.includes(href))).toEqual([]);
    }
  });

  it("finds a section by its exact tab path only, so detail pages get no tab bar", () => {
    expect(findAdminSection("/admin/correspondents")?.label).toBe("Inbox");
    expect(findAdminSection("/admin/blog/some-post")).toBeUndefined();
    expect(findAdminSection("/admin/events")).toBeUndefined();
  });
});
