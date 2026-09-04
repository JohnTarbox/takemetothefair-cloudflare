/**
 * OPE-794 — the capacity classifier, and the two ways it could be dangerous.
 *
 * 1. Inferring OPEN from silence. "No mention of being full" is not evidence a
 *    vendor can apply, and the digest's whole premise is "apply now" — so a
 *    manufactured OPEN puts a CTA on a closed show. `null` (→ UNKNOWN) is the
 *    correct answer to text it does not recognise, and most of the file below
 *    is about pinning that.
 * 2. Reading a real closure as open. Costs a vendor a wasted application.
 *
 * The specimens are the two live events from the ticket, verbatim.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyVendorCapacity } from "@takemetothefair/utils";
import { isOpenToVendorApplications, VENDOR_CAPACITY_STATUSES } from "@takemetothefair/constants";

const OGUNQUIT =
  "We are full for 2026, anyone on our waitlist is to be notified if any spaces become available.";
const MANCHESTER_GRANGE = "The first floor is sold out. Second floor tables are still available.";

describe("classifyVendorCapacity — the live specimens", () => {
  it("reads the Ogunquit page as WAITLIST, not FULL", () => {
    // Both readings are defensible from the words; WAITLIST is the useful one,
    // because it preserves the single actionable fact in the sentence — there
    // is still something a vendor can do.
    const r = classifyVendorCapacity(OGUNQUIT);
    expect(r?.status).toBe("WAITLIST");
    expect(r?.evidence).toContain("waitlist");
  });

  it("reads Manchester Grange as FULL, with the closure as evidence", () => {
    // Partial capacity. The closed reading wins the enum — telling a vendor a
    // sold-out floor is open costs them a wasted application, while the reverse
    // costs them nothing they can measure. The open half survives in the note
    // the caller writes alongside.
    const r = classifyVendorCapacity(MANCHESTER_GRANGE);
    expect(r?.status).toBe("FULL");
    expect(r?.evidence).toMatch(/sold out/i);
  });
});

describe("it does NOT manufacture OPEN", () => {
  it.each([
    ["a plain event description", "Join us for our annual fall craft fair in Manchester."],
    ["fee copy with no capacity claim", "Booth fee is $45 for a 10x10 space. Setup at 7am."],
    ["empty", ""],
    ["whitespace", "   \n  "],
    ["null", null],
    ["undefined", undefined],
  ])("returns null for %s", (_label, text) => {
    expect(classifyVendorCapacity(text as string | null | undefined)).toBeNull();
  });

  it("null is UNKNOWN, and UNKNOWN is not open — the OPE-433 trap", () => {
    // The entire point of the default. If UNKNOWN ever reads as open, every one
    // of the 100+ pre-existing rows silently becomes an invitation to apply.
    expect(isOpenToVendorApplications("UNKNOWN")).toBe(false);
    expect(isOpenToVendorApplications(null)).toBe(false);
    expect(isOpenToVendorApplications(undefined)).toBe(false);
  });
});

describe("recognises a genuine OPEN claim", () => {
  it.each([
    "Booth spaces are still available for this year's fair.",
    "We are still accepting vendors for the 2026 season.",
    "Vendor applications are now open.",
  ])("%s → OPEN", (text) => {
    expect(classifyVendorCapacity(text)?.status).toBe("OPEN");
  });

  it("OPEN is the only status that invites an application", () => {
    // Allow-list, not denylist: a status added later is excluded until somebody
    // decides otherwise. A denylist would silently admit it.
    const open = VENDOR_CAPACITY_STATUSES.filter(isOpenToVendorApplications);
    expect(open).toEqual(["OPEN"]);
    // Positive landmark: the filter examined the whole vocabulary, so this is
    // not a vacuous pass from an empty list.
    expect(VENDOR_CAPACITY_STATUSES.length).toBe(5);
  });
});

describe("recognises closure", () => {
  it.each([
    ["Applications are closed for 2026.", "CLOSED"],
    ["We are no longer accepting vendors.", "CLOSED"],
    ["This year's market is fully booked.", "FULL"],
    ["We are at capacity.", "FULL"],
    ["No more booths are available.", "FULL"],
  ] as const)("%s → %s", (text, status) => {
    expect(classifyVendorCapacity(text)?.status).toBe(status);
  });

  it("a closure later in a long page still wins over earlier open-sounding prose", () => {
    const page = [
      "Welcome to the 38th annual fair.",
      "Vendor applications are now open.",
      "UPDATE: we are full for 2026.",
    ].join(" ");
    // Precedence is by STRENGTH, not by position — otherwise a stale "now open"
    // paragraph at the top of a page beats the update at the bottom, which is
    // exactly how these pages are actually written.
    expect(classifyVendorCapacity(page)?.status).toBe("FULL");
  });
});

/**
 * OPE-794 / OPE-433 — the DEFAULT is the whole lesson, and no classifier test
 * can reach it.
 *
 * Every test above could pass while the column defaulted to 'OPEN' in SQL, and
 * that single word would turn all 100+ pre-existing application rows into
 * invitations to apply to shows nobody checked. `dates_confirmed DEFAULT true`
 * is the same mistake, already made once. So the literal is asserted in both
 * places it is written.
 */
describe("OPE-794 — the column defaults to UNKNOWN, in the migration and the schema", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the migration adds capacity_status DEFAULT 'UNKNOWN'", () => {
    const sql = read("drizzle/0262_ope794_vendor_capacity.sql");
    expect(sql).toMatch(/capacity_status TEXT NOT NULL DEFAULT 'UNKNOWN'/);
    // And says nothing optimistic anywhere else in the file.
    expect(sql).not.toMatch(/DEFAULT 'OPEN'/);
  });

  it("the drizzle schema declares the same default", () => {
    // Two writers of one fact: the migration shapes production, the schema
    // shapes a fresh CI database. They drifting apart is how a column ends up
    // meaning different things in the two places.
    const schema = read("packages/db-schema/src/index.ts");
    expect(schema).toContain('text("capacity_status").notNull().default("UNKNOWN")');
  });
});
