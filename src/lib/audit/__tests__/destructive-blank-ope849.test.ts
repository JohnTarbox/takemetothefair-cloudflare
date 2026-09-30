/**
 * OPE-849 — `isDestructiveBlank`, the predicate that makes a data-destroying
 * save distinguishable from a constructive one.
 *
 * Before this, a save that blanked ten populated fields and a save that filled
 * them in were both `enrichment_log.status='success'` carrying the identical
 * `fields_changed` list. The destruction was invisible for however long it had
 * been happening — the defect shipped 2026-06-10 and was first observed
 * 2026-09-07, by which point the only instrument that could measure it was one
 * day old.
 *
 * ⚠️ This predicate does NOT block anything, and that is deliberate. Clearing a
 * field is legitimate — a vendor deleting their phone number means it. What was
 * wrong was that a blank write was unobservable AND reachable from a client
 * that never loaded the value. The client diff stops the second; this makes the
 * first countable.
 */
import { describe, it, expect } from "vitest";
import { isDestructiveBlank } from "../entity-write-log";

describe("isDestructiveBlank", () => {
  it("is TRUE when a populated field is emptied — the specimen's ten fields", () => {
    // Verbatim from entity_write_log row 9ef74078.
    const wiped: Array<[string, unknown]> = [
      ["description", "Quality Crystals from small Businesses around the world!"],
      ["vendorType", "Crystal and crystal jewelry "],
      ["contactName", "Melissa Dube"],
      ["contactEmail", "melissamdube22@gmail.com"],
      ["contactPhone", "9789943986"],
      ["address", "50 Highland Street, Apt 4"],
      ["city", "Lowell"],
      ["state", "MA"],
      ["zip", "01852"],
    ];
    for (const [field, before] of wiped) {
      expect(`${field}=${isDestructiveBlank(before, "")}`).toBe(`${field}=true`);
    }
    // products went ["Crystals","crystal jewelry"] -> [], which the diff
    // normalizes to the literal "[]". An emptied list is a destroyed list.
    expect(isDestructiveBlank('["Crystals","crystal jewelry"]', "[]")).toBe(true);
  });

  it("is FALSE for the first save on an empty row", () => {
    // Row 066d1a33 blanked 11 fields at 20:52:55 — but every `before` was null.
    // Counting that as destruction would make the detector cry wolf on every
    // new vendor's very first save.
    expect(isDestructiveBlank(null, "")).toBe(false);
    expect(isDestructiveBlank(undefined, "")).toBe(false);
    expect(isDestructiveBlank("", "")).toBe(false);
    expect(isDestructiveBlank("[]", "[]")).toBe(false);
  });

  it("is FALSE when a field is filled in or edited", () => {
    expect(isDestructiveBlank(null, "Lowell")).toBe(false);
    expect(isDestructiveBlank("Lowell", "Boston")).toBe(false);
    expect(isDestructiveBlank("[]", '["Crystals"]')).toBe(false);
  });

  it("treats whitespace-only as empty — a space is not a saved value", () => {
    expect(isDestructiveBlank("Lowell", "   ")).toBe(true);
    expect(isDestructiveBlank("   ", "")).toBe(false);
  });

  it("handles real arrays as well as their normalized string form", () => {
    expect(isDestructiveBlank(["Crystals"], [])).toBe(true);
    expect(isDestructiveBlank([], [])).toBe(false);
  });

  it("does not treat a numeric or boolean value as empty", () => {
    // 0 and false are real saved values; blanking them would be destruction,
    // but they must never themselves READ as already-empty.
    expect(isDestructiveBlank(0, "")).toBe(true);
    expect(isDestructiveBlank(false, "")).toBe(true);
  });
});
