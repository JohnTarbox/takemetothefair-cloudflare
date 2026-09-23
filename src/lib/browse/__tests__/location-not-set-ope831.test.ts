/**
 * OPE-831 (Option A) — every vendor lands on EXACTLY ONE of a by-state page or
 * the "Location not set" bucket, because both are decided by one predicate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { browseStateKey, groupByState, withoutBrowseState, type BrowseEntry } from "../directory";

const e = (name: string, state: string | null): BrowseEntry =>
  ({ name, slug: name.toLowerCase(), state }) as unknown as BrowseEntry;

const FIXTURE: BrowseEntry[] = [
  e("Acme Crafts", "ME"),
  e("Blank State Co", ""),
  e("Null State Co", null),
  e("Whitespace Co", "  "),
  e("Lowercase Co", "nh"),
  e("Finland Co", "Finland"), // invalid code — grouper drops it
  e("Two Letter Junk", "ZZ"),
  e("Vermont Maple", " vt "),
];

describe("the bucket is exactly what the grouper drops", () => {
  it("partition: every entry appears on exactly one surface", () => {
    const byState = groupByState(FIXTURE);
    const inStates = [...byState.values()].flat();
    const bucket = withoutBrowseState(FIXTURE);
    expect(inStates.length + bucket.length).toBe(FIXTURE.length);
    for (const x of FIXTURE) {
      const count = inStates.filter((y) => y === x).length + bucket.filter((y) => y === x).length;
      expect(count, x.name).toBe(1);
    }
  });

  it("blank AND invalid codes both land in the bucket", () => {
    const names = withoutBrowseState(FIXTURE).map((x) => x.name);
    expect(names).toEqual(
      ["Blank State Co", "Finland Co", "Null State Co", "Two Letter Junk", "Whitespace Co"].sort()
    );
  });

  it("browseStateKey normalises and validates", () => {
    expect(browseStateKey({ state: " vt " })).toBe("VT");
    expect(browseStateKey({ state: "Finland" })).toBeNull();
    expect(browseStateKey({ state: null })).toBeNull();
  });
});

describe("the route is noindex,follow and linked from the index", () => {
  const page = readFileSync(
    join(process.cwd(), "src/app/vendors/browse/location-not-set/page.tsx"),
    "utf8"
  );
  it("declares robots noindex,follow", () => {
    expect(page).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*true\s*\}/);
  });
  it("uses the shared predicate, not a copy", () => {
    expect(page).toMatch(/withoutBrowseState\(await getVendorBrowseEntries\(db\)\)/);
  });
  it("is linked from /vendors/browse and absent from the static sitemap", () => {
    const index = readFileSync(join(process.cwd(), "src/app/vendors/browse/page.tsx"), "utf8");
    expect(index).toContain('href="/vendors/browse/location-not-set"');
    const sitemap = readFileSync(
      join(process.cwd(), "src/app/sitemap-static.xml/route.ts"),
      "utf8"
    );
    expect(sitemap).not.toContain("location-not-set");
  });
});
