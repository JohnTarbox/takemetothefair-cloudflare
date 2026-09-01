/**
 * OPE-723 — keep the abbreviation map's narrowing hole from reopening in silence.
 *
 * `selectStemCandidates` narrows with `LIKE '%<stem>%'` against the RAW
 * `business_name`; `combinedSimilarity` scores the NORMALIZED one. An
 * abbreviation whose short form is not a literal substring of its expansion is
 * therefore invisible to the narrowing in BOTH directions — the true match is
 * never fetched, so it is never scored, so the tool reports no duplicate and
 * mints a new vendor.
 *
 * That failure is indistinguishable from "there genuinely is no duplicate",
 * which is why it went unnoticed through two tickets. A comment saying
 * "re-check this before adding an entry" cannot catch it. This can.
 *
 * The map was measured against prod on 2026-09-01 and found EMPTY of live
 * instances (`assn` and `intl` appear in zero vendor rows; `mfg`'s two rows and
 * `manufacturing`'s one are three distinct businesses). So this guard does not
 * assert the hole is closed — it asserts that nobody widens it without saying so.
 */
import { describe, it, expect } from "vitest";
import { US_STATE_ABBREVIATION_MAP, VENDOR_ABBREVIATION_MAP } from "@takemetothefair/utils";

/**
 * Abbreviations known NOT to be substrings of their expansion, each measured
 * against production and found to have zero colliding pairs.
 *
 * Adding an entry here is a claim that you ran the query. Adding one to
 * VENDOR_ABBREVIATION_MAP without adding it here fails the test below.
 */
const MEASURED_UNSAFE: Record<string, string> = {
  assn: "0 rows in vendors on 2026-09-01 — cannot collide",
  mfg: "2 rows vs 1 `manufacturing` row on 2026-09-01, three distinct businesses",
  intl: "0 rows in vendors on 2026-09-01 — cannot collide",
  // Filed as substring-SAFE on OPE-723. It is not: "brothers" has no "bros" in
  // it. This guard is what caught that, which is the argument for the guard.
  bros: "1 `bros` row (Geaghan Bros.) vs 12 `brothers` rows on 2026-09-01, no shared business",
};

describe("every abbreviation is either substring-safe or measured", () => {
  it("classifies each entry and demands a measurement for the unsafe ones", () => {
    const unrecorded: string[] = [];
    for (const [short, long] of Object.entries(VENDOR_ABBREVIATION_MAP)) {
      const substringSafe = long.includes(short);
      if (!substringSafe && !(short in MEASURED_UNSAFE)) unrecorded.push(`${short} -> ${long}`);
    }
    expect(unrecorded).toEqual([]);
  });

  it("keeps the one genuinely safe entry honest — it is safe only while the substring holds", () => {
    // `assoc` needs no measurement ONLY because the short form is a literal
    // prefix of `association`. If that expansion is ever reworded, the entry
    // silently becomes unsafe and the test above starts demanding a
    // measurement — which is the point.
    expect(VENDOR_ABBREVIATION_MAP.assoc.includes("assoc")).toBe(true);
  });

  it("`bros` is NOT substring-safe, whatever the ticket said", () => {
    // OPE-723 filed `bros -> brothers` alongside `assoc -> association` as safe
    // "because the short form IS a substring of the long one". For `bros` that
    // is simply false — b-r-o-s does not occur in b-r-o-t-h-e-r-s — and the
    // claim survived being written down, reviewed and filed. Pinned so the
    // wrong version cannot come back.
    expect("brothers".includes("bros")).toBe(false);
    expect(Object.keys(MEASURED_UNSAFE)).toContain("bros");
  });

  it("does not go vacuously green on an empty or shrunken map", () => {
    // A guard that iterates nothing passes forever. The map had 5 entries when
    // this was written; fewer means something was deleted and this test should
    // be re-read rather than silently kept.
    expect(Object.keys(VENDOR_ABBREVIATION_MAP).length).toBeGreaterThanOrEqual(5);
  });

  it("flags a measurement note that records nothing", () => {
    // "unused" / "n/a" is how an allow-list rots into a rubber stamp.
    for (const [short, note] of Object.entries(MEASURED_UNSAFE)) {
      expect(note.length, `${short} needs a real measurement, not a placeholder`).toBeGreaterThan(
        20
      );
    }
  });

  it("detects list rot — a MEASURED_UNSAFE entry no longer in the map", () => {
    const stale = Object.keys(MEASURED_UNSAFE).filter((k) => !(k in VENDOR_ABBREVIATION_MAP));
    expect(stale, "remove these from MEASURED_UNSAFE").toEqual([]);
  });
});

/**
 * OPE-739 added a SECOND map folded in the same token pass. The guard has to
 * cover it or the rule holds for one map and not the other — which is how a
 * "fix wired into one of two parallel paths" happens, the failure mode this
 * repo has hit repeatedly.
 *
 * State codes are held to a STRICTER bar than legal-form abbreviations. `mfg`
 * cannot be an English word; `me` and `ma` obviously can, and a wrong expansion
 * there produces a wrong MERGE, which `merge_vendor` cannot undo.
 */
const STATE_CODE_MEASUREMENTS: Record<string, string> = {
  nh: "9 colliding pairs on 2026-09-01, 2 still live; nh is the state in every prod occurrence",
};

describe("state codes are an allow-list, and every entry names its measurement", () => {
  it("no state code is present without one", () => {
    const unrecorded = Object.keys(US_STATE_ABBREVIATION_MAP).filter(
      (k) => !(k in STATE_CODE_MEASUREMENTS)
    );
    expect(unrecorded).toEqual([]);
  });

  it("refuses the codes that are also ordinary English words", () => {
    // `me` is the pronoun in nine live vendor names ("The Sea by Me" x3,
    // "Waffle Me", "Love Rocks Me", ...). `ma`, `in`, `or`, `hi`, `ok`, `de`
    // and `pa` are words or names too. None may be expanded, whatever a future
    // measurement says about colliding pairs — a pair count cannot see the rows
    // a wrong expansion would damage.
    for (const word of ["me", "ma", "in", "or", "hi", "ok", "de", "pa", "id", "la"]) {
      expect(
        US_STATE_ABBREVIATION_MAP,
        `${word} is an English word, not just a state`
      ).not.toHaveProperty(word);
    }
  });

  it("does not go vacuously green on an empty map", () => {
    expect(Object.keys(US_STATE_ABBREVIATION_MAP).length).toBeGreaterThanOrEqual(1);
  });

  it("detects list rot in the state measurements", () => {
    const stale = Object.keys(STATE_CODE_MEASUREMENTS).filter(
      (k) => !(k in US_STATE_ABBREVIATION_MAP)
    );
    expect(stale, "remove these from STATE_CODE_MEASUREMENTS").toEqual([]);
  });
});
