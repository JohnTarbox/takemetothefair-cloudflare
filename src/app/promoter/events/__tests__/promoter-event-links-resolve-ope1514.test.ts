/**
 * OPE-1514 — the promoter portal linked "Edit event" to
 * /promoter/events/<id>/edit for every submitted event, and that route had
 * never existed: every click 404'd, from the first Cloudflare commit until
 * 2026-11-02 (John chose option D: remove it, offer "Vendor call" + "Request a
 * change").
 *
 * Structural rather than a fix-list: every `/promoter/events/${…}/<segment>`
 * link written anywhere under src/app/promoter must have a page at
 * src/app/promoter/events/[id]/<segment>/page.tsx. A future dead link fails here
 * whatever it is called.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src/app/promoter");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : tsxFiles(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

// `/promoter/events/${event.id}/vendor-call` → "vendor-call"
const LINK = /\/promoter\/events\/\$\{[^}]+\}\/([a-z0-9-]+)/g;

function linkedSegments(): { file: string; segment: string }[] {
  return tsxFiles(ROOT).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(LINK)].map((m) => ({ file, segment: m[1] }))
  );
}

describe("OPE-1514 — every per-event promoter link resolves to a page", () => {
  it("landmark: the scan finds the per-event links that exist (vendor-call)", () => {
    const segs = linkedSegments().map((l) => l.segment);
    expect(segs).toContain("vendor-call");
  });

  it("each linked segment has a page.tsx under events/[id]/", () => {
    const dead = linkedSegments().filter(
      ({ segment }) => !existsSync(join(ROOT, "events/[id]", segment, "page.tsx"))
    );
    expect(dead).toEqual([]);
  });

  it("the My Events list offers 'Request a change' and no longer links /edit", () => {
    const page = readFileSync(join(ROOT, "events/page.tsx"), "utf8");
    expect(page).not.toMatch(/\/promoter\/events\/\$\{event\.id\}\/edit/);
    expect(page).toContain('aria-label="Request a change"');
    expect(page).toContain("mailto:corrections@meetmeatthefair.com?subject=");
  });
});
