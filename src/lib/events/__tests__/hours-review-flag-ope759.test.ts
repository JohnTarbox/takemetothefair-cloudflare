/**
 * OPE-759 — the hours axis of `events.flagged_for_review`.
 *
 * The ticket's acceptance is explicit: *"Do not accept on 'added a recompute'."*
 * So these test the RULE at the point where a wrong version and a right version
 * give different answers, and the monotonicity is asserted rather than assumed —
 * because "it never clears" is a deliberate design decision that a later reader
 * will be tempted to undo.
 */
import { describe, it, expect } from "vitest";
import { shouldRaiseHoursFlag } from "@takemetothefair/db-schema";

describe("shouldRaiseHoursFlag — OPE-759", () => {
  it("raises when any day lacks hours", () => {
    expect(shouldRaiseHoursFlag({ daysChecked: 4, unknownDays: 1 })).toBe(true);
  });

  it("raises when EVERY day lacks hours — the seven-event signature", () => {
    // north-adams-farmers-market-summer-2026: 18 days, 18 unknown, flagged 0.
    // This is the shape that says a bulk writer never flagged, rather than a
    // clear that misfired.
    expect(shouldRaiseHoursFlag({ daysChecked: 18, unknownDays: 18 })).toBe(true);
  });

  it("does NOT raise when every day is houred — the 502-event normal case", () => {
    // The positive landmark from the ticket's own census. Without a case where
    // the answer is false, a rule that returns true unconditionally passes
    // every test above.
    expect(shouldRaiseHoursFlag({ daysChecked: 4, unknownDays: 0 })).toBe(false);
  });

  it("LANDMARK: does NOT raise on an event with no day rows at all", () => {
    // A season-span event with no per-date rows yet must not be flagged by an
    // axis that has nothing to say about it.
    //
    // ⚠️ Labelled LANDMARK because it does NOT discriminate, and I checked
    // rather than assumed: deleting the `daysChecked <= 0` line from the rule
    // leaves this test green. It has to, because `unknownDays` is a COUNT of a
    // subset of `daysChecked`, so `daysChecked === 0` forces `unknownDays === 0`
    // and `0 > 0` is already false. The explicit line is documentation of an
    // invariant the caller could otherwise violate by passing garbage — it is
    // not a live branch, and claiming this test covers it would be exactly the
    // vacuous green OPE-6 v3.8 is about.
    expect(shouldRaiseHoursFlag({ daysChecked: 0, unknownDays: 0 })).toBe(false);
  });

  it("does not trust a caller that reports more unknown days than days", () => {
    // THIS is what the `daysChecked <= 0` line actually guards, and it is the
    // case that discriminates: an incoherent count pair. Without the line,
    // `0 unknown of 0 days` is fine but a bad caller passing `{0, 3}` would
    // raise a flag on an event with no days at all.
    expect(shouldRaiseHoursFlag({ daysChecked: 0, unknownDays: 3 })).toBe(false);
  });
});

describe("OPE-759 — the rule is MONOTONIC, and that is deliberate", () => {
  it("exports no clear-side rule", async () => {
    // ⚠️ This is a design assertion, not a coverage one, and it is here because
    // the omission looks exactly like an oversight.
    //
    // `flagged_for_review` is ONE boolean carrying SEVERAL independent reasons —
    // hours, a new series occurrence (create-occurrence.ts:249), a URL import
    // (import-url/route.ts:418), an annual rollover (event-rollover.ts:254) —
    // and nothing records which one applies. Clearing it because the hours are
    // now complete would silently discharge the others.
    //
    // If someone later adds a principled clear (a reason column, say), this
    // test failing is the intended signal to come and read why it was absent.
    const mod = await import("@takemetothefair/db-schema");
    const clearish = Object.keys(mod).filter(
      (k) => /hours/i.test(k) && /clear|lower|reset|unflag/i.test(k)
    );
    expect(
      clearish,
      "a clear-side hours rule appeared — `flagged_for_review` carries several " +
        "reasons and records none of them, so read hours-review-flag.ts before keeping this"
    ).toEqual([]);

    // Positive landmark: the module really does export the raise-side rule, so
    // an empty result above cannot be an import that resolved to nothing.
    expect(Object.keys(mod)).toContain("shouldRaiseHoursFlag");
  });
});

describe("OPE-759 — every event_days writer maintains the flag", () => {
  it("has no writer that inserts days without raising it", async () => {
    // The structural guard, keyed on the TABLE rather than on the four call
    // sites this ticket fixed.
    //
    // The defect was never "update_event_day is missing a clear" — it is that
    // `event_days` had FIVE writers and ONE maintained the flag. A guard naming
    // those four would be blind to the sixth writer, which is how this recurs.
    const { readFile } = await import("node:fs/promises");
    const { execSync } = await import("node:child_process");

    // `|| true` so grep's exit-1-on-no-match does not throw and turn "found
    // nothing" into an error that reads like a different failure.
    const out = execSync(
      `grep -rln "insert(eventDays)" --include=*.ts src/ | grep -v __tests__ || true`,
      { encoding: "utf8", cwd: process.cwd() }
    ).trim();
    const files = out ? out.split("\n").filter(Boolean) : [];

    // Landmark: if the search stops finding writers, "no offenders" is
    // indistinguishable from "no search".
    expect(
      files.length,
      "no `insert(eventDays)` writers found in src/ — the guard has gone inert, not passed"
    ).toBeGreaterThanOrEqual(4);

    const offenders: string[] = [];
    for (const f of files) {
      const src = await readFile(f, "utf8");
      // ⚠️ Anchored on the CALL syntax, not the bare symbol.
      //
      // The first version of this guard tested `src.includes("raiseHoursReviewFlag")`
      // and was INERT: deleting the call from a writer left the IMPORT line
      // behind, which still contains the identifier, so the guard stayed green
      // while the defect was back. Found by driving it to failure (OPE-6 v3.8),
      // not by review — and it is the same trap this codebase already has a
      // note about (`indexOf` on a bare symbol matches the import line).
      if (!/\braiseHoursReviewFlag\s*\(/.test(src)) offenders.push(f);
    }

    expect(
      offenders,
      "these files write event_days without re-deriving the hours flag, which is " +
        "the exact defect OPE-759 fixed — seven events with every day hourless sat " +
        `unflagged because their writer never raised it: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
