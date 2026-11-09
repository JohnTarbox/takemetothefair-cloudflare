/**
 * OPE-1573 — admin links must not prefetch.
 *
 * Every /admin route is force-dynamic, so a prefetching <Link> is a full RSC
 * render (requireAdmin + the page's D1 reads) fired the moment it scrolls into
 * view. One /admin/analytics load fired ~70 of them; during the 2026-11-04
 * 01:43Z D1 overload several returned 503 alongside the page itself.
 *
 * Source-level check: each JSX `<Link` opening in these files must carry
 * `prefetch={false}` as its first attribute. The match anchors on the JSX
 * opening (`<Link` + whitespace), not the bare identifier, so the import line
 * and prose like "a `<Link>`" in a comment don't count.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FILES: { file: string; minLinks: number }[] = [
  // The sidebar: one <Link> rendered once per adminNav entry, on every admin page.
  { file: "src/app/admin/layout.tsx", minLinks: 1 },
  // OPE-1602: the section tab bar renders in that same layout, on every tabbed page.
  { file: "src/app/admin/admin-section-tabs.tsx", minLinks: 1 },
  // The default analytics tab's in-page links (tile overlays, tabs, row links).
  { file: "src/app/admin/analytics/page.tsx", minLinks: 13 },
];

function linkOpenings(source: string): string[] {
  // `<Link` followed by whitespace: the start of a JSX element with attributes.
  // Capture what comes right after it.
  return [...source.matchAll(/<Link\s+([^\s>]+)/g)].map((m) => m[1]);
}

describe("admin <Link> prefetch (OPE-1573)", () => {
  for (const { file, minLinks } of FILES) {
    it(`${file}: every <Link> opens with prefetch={false}`, () => {
      const src = readFileSync(path.resolve(process.cwd(), file), "utf8");
      const firstAttrs = linkOpenings(src);

      // Positive landmark: the matcher still finds the links. If it silently
      // stopped matching, the check below would pass on zero candidates.
      expect(firstAttrs.length).toBeGreaterThanOrEqual(minLinks);

      const offenders = firstAttrs.filter((a) => a !== "prefetch={false}");
      expect(offenders).toEqual([]);
    });
  }
});
