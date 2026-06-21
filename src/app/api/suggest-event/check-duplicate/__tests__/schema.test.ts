import { describe, it, expect } from "vitest";
import { checkDuplicateSchema } from "../route";

// K29 (2026-06-21) regression: the email pipeline sends extracted fields that
// can be an explicit `null` when a signal is absent. Before this fix the schema
// used `.optional()` only, so a single null (e.g. `venueCity: null`) returned a
// 400 and the caller silently skipped dedup — accepting events that should have
// merged. The schema must now accept null on every field and hand it through to
// findDuplicate (whose input treats null as "missing").
describe("checkDuplicateSchema null tolerance", () => {
  it("accepts an explicit null on a venue field", () => {
    const r = checkDuplicateSchema.safeParse({
      name: "Winthrop Arts Festival",
      startDate: "2026-08-15",
      venueCity: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.venueCity).toBeNull();
  });

  it("accepts null on every field at once", () => {
    const r = checkDuplicateSchema.safeParse({
      sourceUrl: null,
      name: null,
      startDate: null,
      venueName: null,
      venueAddress: null,
      venueCity: null,
      venueState: null,
    });
    expect(r.success).toBe(true);
  });

  it("still accepts omitted (undefined) fields", () => {
    const r = checkDuplicateSchema.safeParse({ name: "Foo" });
    expect(r.success).toBe(true);
  });

  it("still rejects a non-URL sourceUrl", () => {
    const r = checkDuplicateSchema.safeParse({ sourceUrl: "not-a-url" });
    expect(r.success).toBe(false);
  });

  it("still rejects a wrong-typed field (number for name)", () => {
    const r = checkDuplicateSchema.safeParse({ name: 123 });
    expect(r.success).toBe(false);
  });
});
