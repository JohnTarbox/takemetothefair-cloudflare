/**
 * OPE-1061 — constraint 1 at the RENDER site: the event page answers only
 * from the event's own `petFriendly`, never from the venue's.
 *
 * Source-level, because the page is a server component over live D1. Anchored
 * on CALL syntax, not bare symbols: a bare `indexOf("petPolicyDisplay")`
 * matches the import line and goes vacuously green.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../..");
const eventPage = readFileSync(join(ROOT, "src/app/events/[slug]/page.tsx"), "utf8");
const venuePage = readFileSync(join(ROOT, "src/app/venues/[slug]/page.tsx"), "utf8");

describe("OPE-1061 — no venue→event inheritance on the page", () => {
  it("the event page renders from event.petFriendly and nothing else", () => {
    const calls = eventPage.match(/petPolicyDisplay\(([^)]*)\)/g) ?? [];
    // Landmark: the render call exists, so the absence below is meaningful.
    expect(calls).toEqual(["petPolicyDisplay(event.petFriendly)"]);
    expect(eventPage).not.toMatch(/venuePetPolicyDisplay\(/);
    expect(eventPage).not.toMatch(/venue\??\.petFriendly/);
  });

  it("the venue page renders the venue's own, labelled line", () => {
    expect(venuePage.match(/venuePetPolicyDisplay\(([^)]*)\)/g)).toEqual([
      "venuePetPolicyDisplay(venue.petFriendly)",
    ]);
  });
});
