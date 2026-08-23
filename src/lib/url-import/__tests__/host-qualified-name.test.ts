/**
 * OPE-378 defect 4 — the host-in-name convention.
 *
 * The specimen: one submission to submit@ produced "28th Annual Craft Fair".
 * True, and useless — it identifies no fair, collides with every other craft
 * fair in Maine, and the source names the organizer in its first clause
 * ("Waterville Elks Lodge #905 is currently seeking crafters…").
 *
 * The rule is deterministic on purpose. Defect 2 of this same ticket was an
 * invented word in a name, so the fix for defect 4 must not be another model
 * call that is free to write prose.
 */
import { describe, it, expect } from "vitest";
import { isGenericEventName, qualifyNameWithHost } from "../host-qualified-name";

describe("isGenericEventName", () => {
  it("calls the specimen generic", () => {
    expect(isGenericEventName("28th Annual Craft Fair")).toBe(true);
    expect(isGenericEventName("28th Annual Holiday Craft Fair")).toBe(true);
  });

  it("treats seasonal and occasion words as generic, not distinguishing", () => {
    expect(isGenericEventName("Holiday Craft Fair")).toBe(true);
    expect(isGenericEventName("Summer Arts Festival")).toBe(true);
    expect(isGenericEventName("Fall Vendor Market 2026")).toBe(true);
  });

  it("leaves a name with any proper-noun anchor alone", () => {
    expect(isGenericEventName("Fryeburg Fair")).toBe(false);
    expect(isGenericEventName("Waterville Elks Lodge #905 Craft Fair")).toBe(false);
    expect(isGenericEventName("Maine Lobster Festival")).toBe(false);
  });

  it("ignores ordinals, bare edition numbers and years", () => {
    // None of these tell two fairs apart, so none rescues a generic name.
    expect(isGenericEventName("3rd Annual Fair")).toBe(true);
    expect(isGenericEventName("28 Annual Craft Fair")).toBe(true);
    expect(isGenericEventName("Craft Fair 2026")).toBe(true);
  });

  it("keeps real Maine fair names out of the generic bucket", () => {
    // The place-word list is the risky part: adding "common"/"ground"/"hall"
    // could have swallowed real names. These are the ones that would notice.
    expect(isGenericEventName("Common Ground Country Fair")).toBe(false); // "country"
    expect(isGenericEventName("Cumberland County Fair")).toBe(false); // "cumberland"
    expect(isGenericEventName("Grange Hall Artisans Festival")).toBe(false); // "grange"
    expect(isGenericEventName("Blue Hill Fair")).toBe(false); // "blue", "hill"
  });

  it("does not claim an empty or punctuation-only name", () => {
    // That is isUnusableEventName's job; overlapping would double-handle it.
    expect(isGenericEventName("")).toBe(false);
    expect(isGenericEventName("   ---  ")).toBe(false);
  });
});

describe("qualifyNameWithHost", () => {
  it("fixes the live specimen", () => {
    const out = qualifyNameWithHost("28th Annual Craft Fair", "Waterville Elks Lodge #905");
    expect(out.applied).toBe(true);
    expect(out.name).toBe("Waterville Elks Lodge #905 28th Annual Craft Fair");
  });

  it("keeps the original name intact — it prefixes, never edits", () => {
    // The whole reason prefixing is safe where deletion is not.
    const original = "28th Annual Craft Fair";
    expect(qualifyNameWithHost(original, "Waterville Elks Lodge #905").name).toContain(original);
  });

  it("leaves a specific name untouched", () => {
    const out = qualifyNameWithHost("Fryeburg Fair", "Fryeburg Fairgrounds");
    expect(out.applied).toBe(false);
    expect(out.name).toBe("Fryeburg Fair");
    expect(out.reason).toBe("name-is-specific");
  });

  it("declines when the host is itself generic", () => {
    // "Fairgrounds Craft Fair" is more words and no more information.
    const out = qualifyNameWithHost("Craft Fair", "The Fairgrounds");
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("host-is-generic");
  });

  it("exits at name-is-specific when the host is already in the name", () => {
    // Not a separate guard: a name carrying the host's distinguishing tokens is
    // not generic, so it can never reach a would-be "already qualified" branch.
    // One was written here and deleted when this test proved it unreachable.
    const out = qualifyNameWithHost("Waterville Elks Lodge Craft Fair", "Waterville Elks Lodge");
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("name-is-specific");
  });

  it("does not double-qualify on a second pass", () => {
    // The practical consequence of the above, and the one that would bite:
    // re-running the convention on its own output must be a no-op.
    const once = qualifyNameWithHost("28th Annual Craft Fair", "Waterville Elks Lodge #905");
    const twice = qualifyNameWithHost(once.name, "Waterville Elks Lodge #905");
    expect(twice.applied).toBe(false);
    expect(twice.name).toBe(once.name);
  });

  it("declines with a reason when there is no host at all", () => {
    expect(qualifyNameWithHost("Craft Fair", null).reason).toBe("no-host");
    expect(qualifyNameWithHost("Craft Fair", "   ").reason).toBe("no-host");
  });

  it("declines rather than producing a name too long to store", () => {
    // nameSchema caps at 200; stopping at 180 leaves room for a year suffix.
    const out = qualifyNameWithHost("Craft Fair", "X".repeat(190));
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("too-long");
    expect(out.name).toBe("Craft Fair");
  });

  it("never returns a silent no-op — every decline names its reason", () => {
    const declines = [
      qualifyNameWithHost("Fryeburg Fair", "Host Co"),
      qualifyNameWithHost("Craft Fair", null),
      qualifyNameWithHost("Craft Fair", "The Fairgrounds"),
      qualifyNameWithHost("Elks Lodge Craft Fair", "Elks Lodge"),
      qualifyNameWithHost("Craft Fair", "X".repeat(190)),
    ];
    for (const d of declines) {
      expect(d.applied).toBe(false);
      expect(d.reason).toBeTruthy();
    }
  });
});

describe("the convention composes with the OPE-378 grounding gate", () => {
  it("adds only tokens that came from the submission", async () => {
    // Defect 2 and defect 4 pull in opposite directions, so this is the seam
    // worth pinning: qualifying a name must never trip the fabrication gate.
    const { groundNameInSources } = await import("../name-grounding");
    const host = "Waterville Elks Lodge #905";
    const body =
      "Waterville Elks Lodge #905 is currently seeking crafters for their annual " +
      "craft fair on Sunday, November 1, 2026. This is our 28th Annual event.";

    const qualified = qualifyNameWithHost("28th Annual Craft Fair", host);
    expect(qualified.applied).toBe(true);
    expect(groundNameInSources(qualified.name, [body]).shouldFlag).toBe(false);
  });
});

/**
 * The convention is worthless if the route applies it after the slug is cut.
 *
 * `/api/suggest-event/submit` derives `eventSlug` from `effectiveName`, so a
 * name qualified any later would produce a page whose URL and title disagree.
 * Asserted against the source because the route itself needs D1, auth and a
 * live venue matcher to run.
 *
 * Anchored on the CALL syntax (`qualifyNameWithHost(`), not the bare symbol:
 * a bare-symbol search matches the import line at the top of the file and the
 * ordering assertion goes vacuously green.
 */
describe("the submit route applies the convention before it cuts the slug", () => {
  it("calls qualifyNameWithHost ahead of createSlug(effectiveName)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "..", "..", "..", "app", "api", "suggest-event", "submit", "route.ts"),
      "utf8"
    );

    const callAt = source.indexOf("qualifyNameWithHost(baseName");
    const slugAt = source.indexOf("createSlug(effectiveName)");

    expect(callAt).toBeGreaterThan(-1);
    expect(slugAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(slugAt);
  });

  it("records the rewrite in gate_flags without routing it to review", async () => {
    // A qualified name is MORE correct than the one we were given, so sending
    // it to review would punish the fix. The flag exists to make the rewrite
    // queryable, not to gate it.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source: string = readFileSync(
      resolve(__dirname, "..", "..", "..", "app", "api", "suggest-event", "submit", "route.ts"),
      "utf8"
    );

    const line = source
      .split("\n")
      .find((l: string) => l.includes('gateReasons.push("host_qualified_name")'));
    expect(line).toBeTruthy();
    expect(line).not.toContain("PENDING_REVIEW");
  });
});
