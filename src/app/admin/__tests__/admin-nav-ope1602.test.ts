/**
 * OPE-1602 — every admin page is reachable from the sidebar, or is listed here
 * with the reason it isn't. A new page.tsx with neither fails this test, which is
 * how 11 routes ended up with no way in.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminNavGroups } from "../admin-nav";

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
  "/admin/analytics/page": "stray route, removed by OPE-1604",
  "/admin/og-image-sweep": "retired by OPE-1604",
  "/admin/backfill-source-domain": "retired by OPE-1604",
  "/admin/snap": "phone tool. The review wants a mobile dashboard link, not built yet (OPE-1602)",
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
    expect(linked.length).toBeGreaterThan(25);
    expect(new Set(linked).size).toBe(linked.length);
    const routes = new Set(adminRoutes());
    expect(linked.filter((href) => !routes.has(href))).toEqual([]);
  });

  it("reaches every admin page, or says why not", () => {
    const routes = adminRoutes();
    // A positive landmark, so a walker that stops finding pages cannot pass.
    expect(routes.length).toBeGreaterThan(35);
    const unreachable = routes.filter((r) => !linked.includes(r) && !(r in NOT_IN_SIDEBAR));
    expect(unreachable).toEqual([]);
  });

  it("carries no exemption for a page that is gone or now linked", () => {
    const routes = new Set(adminRoutes());
    const stale = Object.keys(NOT_IN_SIDEBAR).filter((r) => !routes.has(r) || linked.includes(r));
    expect(stale).toEqual([]);
  });
});
