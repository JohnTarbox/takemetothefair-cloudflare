/**
 * OPE-738 → OPE-1394 — /fair-entry-deadlines is unconditionally public.
 *
 * OPE-738 shipped the page dark behind ENTRY_DEADLINES_INDEX and this file
 * pinned that gate. John approved publishing on 2026-09-02 and the flag sat at
 * "true" from then on, so its OFF branch (a notFound() on the route and a
 * hidden footer link) was dead code. OPE-1394 retired it.
 *
 * What is pinned now is the retirement itself, from both ends:
 *   - no [vars] line survives that would LOOK like a working kill switch
 *     (a stale `ENTRY_DEADLINES_INDEX = "false"` edit would silently do
 *     nothing, which is worse than no line);
 *   - the page does not 404 itself and the footer links it unconditionally, so
 *     the entry point and the page cannot drift apart.
 * Taking the page down is now a code change, reviewed like one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readWranglerConfig, wranglerVars } from "../../../../scripts/lib/wrangler-config";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

describe("OPE-1394 — /fair-entry-deadlines gate retired", () => {
  it("no longer declares ENTRY_DEADLINES_INDEX in the committed wrangler.toml", () => {
    expect(wranglerVars(readWranglerConfig("main"))).not.toHaveProperty("ENTRY_DEADLINES_INDEX");
  });

  it("the route does not 404 itself on a flag", () => {
    const page = read("src", "app", "fair-entry-deadlines", "page.tsx");
    expect(page).not.toMatch(/notFound\(\)/);
    // A read of the retired var in any form (the header comment may still name it).
    expect(page).not.toMatch(
      /isEntryDeadlinesIndexEnabled|\.ENTRY_DEADLINES_INDEX|"ENTRY_DEADLINES_INDEX"/
    );
  });

  it("the footer links the page unconditionally", () => {
    const footer = read("src", "components", "layout", "footer.tsx");
    expect(footer).toMatch(/\{ name: "Fair Entry Deadlines", href: "\/fair-entry-deadlines" \}/);
    expect(footer).not.toMatch(/isEntryDeadlinesIndexEnabled/);
  });
});
