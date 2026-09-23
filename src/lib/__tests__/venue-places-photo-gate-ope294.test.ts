/**
 * OPE-294 review bounce (2026-09-23) — the hotlinked-venue count grew 172 → 174
 * after the gate shipped, because `ALLOW_GOOGLE_PLACES_PHOTOS` guarded ONE
 * writer (google-backfill) while the admin venue forms and venue-combo-search
 * copied a Places `photoUrl` into `imageUrl` and the server wrote it.
 * Specimens: Danville Community Center (09-19), St. Matthew Catholic Church
 * (09-11), both `venue.create` by a user through the UI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { withoutGooglePlacesPhoto } from "@takemetothefair/utils";

const ROOT = resolve(process.cwd());

describe("withoutGooglePlacesPhoto", () => {
  it("drops the specimens' Places photo URLs (lh3, any Places subdomain)", () => {
    expect(
      withoutGooglePlacesPhoto(
        "https://lh3.googleusercontent.com/place-photos/AG9NLjDaZhoHh=s4800-w800"
      )
    ).toBeNull();
    expect(
      withoutGooglePlacesPhoto("https://lh3.googleusercontent.com/grass-cs/ACvplmMdsdg6D79tq=w800")
    ).toBeNull();
    expect(withoutGooglePlacesPhoto("https://lh5.googleusercontent.com/p/AF1Qip")).toBeNull();
  });

  it("keeps owned and other images, and preserves undefined (PATCH: 'not mentioned')", () => {
    const owned = "https://cdn.meetmeatthefair.com/venues/v1/hero.webp";
    expect(withoutGooglePlacesPhoto(owned)).toBe(owned);
    expect(withoutGooglePlacesPhoto("https://example.org/venue.jpg")).toBe(
      "https://example.org/venue.jpg"
    );
    expect(withoutGooglePlacesPhoto(undefined)).toBeUndefined();
    expect(withoutGooglePlacesPhoto(null)).toBeNull();
    expect(withoutGooglePlacesPhoto("")).toBe("");
  });
});

/**
 * Keyed on the ACT — writing `venues` — not on the fix: a file that writes the
 * venues table AND mentions `imageUrl` must apply the gate, or be on this
 * reviewed list with the reason it cannot introduce a Places photo. A new
 * writer fails here until someone looks at it; that is the point.
 */
const REVIEWED_NO_GATE_NEEDED: Record<string, string> = {
  "src/lib/upload-image-pipeline.ts": "writes only an owned CDN URL it just uploaded",
  "src/app/api/admin/venues/image-heal/route.ts": "writes an owned re-host or NULL",
  "src/app/api/admin/venues/google-backfill/route.ts":
    "has its own ALLOW_GOOGLE_PLACES_PHOTOS gate",
  "src/app/api/admin/import/route.ts": "imageUrl here is the EVENT image, not the venue's",
  "src/app/api/admin/import-url/route.ts": "imageUrl here is the EVENT image, not the venue's",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("every venue writer that touches imageUrl applies the gate", () => {
  it("app routes and libs", () => {
    const offenders: string[] = [];
    let writers = 0;
    for (const f of walk(join(ROOT, "src"))) {
      const src = readFileSync(f, "utf8");
      if (!/\.(insert|update)\(venues\)/.test(src) || !/\bimageUrl\b/.test(src)) continue;
      writers++;
      const rel = f.slice(ROOT.length + 1);
      if (REVIEWED_NO_GATE_NEEDED[rel]) continue;
      if (!src.includes("withoutGooglePlacesPhoto(")) offenders.push(rel);
    }
    expect(writers).toBeGreaterThanOrEqual(7); // landmark: the scan found the writers
    expect(offenders).toEqual([]);
  });

  it("MCP create_venue and update_venue both gate image_url", () => {
    const src = readFileSync(join(ROOT, "mcp-server/src/tools/admin.ts"), "utf8");
    expect(src.match(/withoutGooglePlacesPhoto\(u\) === null \? undefined : u/g)?.length).toBe(2);
  });

  it("no client form copies a Places photoUrl into imageUrl any more", () => {
    for (const f of [
      "src/app/admin/venues/new/page.tsx",
      "src/app/admin/venues/[id]/edit/page.tsx",
      "src/components/venue-combo-search.tsx",
    ]) {
      expect(readFileSync(join(ROOT, f), "utf8")).not.toMatch(/imageUrl:\s*\w+\.photoUrl/);
    }
  });
});
