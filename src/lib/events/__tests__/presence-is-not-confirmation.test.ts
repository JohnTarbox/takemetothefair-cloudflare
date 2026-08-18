/**
 * OPE-433 — "has a date" was being written as "date is confirmed".
 *
 * The ticket attributes the 1,245 uncited-but-confirmed rows to
 * `dates_confirmed DEFAULT true`. The default was permissive, but it was not
 * the mechanism: the two bulk importers stated `true` outright, derived from
 * the mere presence of a parsed date.
 *
 *   /api/admin/import      datesConfirmed: eventData.datesConfirmed ?? (eventData.startDate ? true : false)
 *   /api/admin/import-url  datesConfirmed: event.datesConfirmed ?? startDate !== null
 *
 * Those two lanes are exactly the ones the ticket singles out — the
 * measured distribution puts `aggregator_import` at 280/284 confirmed and
 * `direct_scrape` at 401/420, against `annual_rollover`'s 1/121. Flipping the
 * DDL default would have changed neither, because neither ever read it.
 *
 * These are source-level assertions rather than route invocations: the routes
 * need D1, auth and a venue matcher, and the property under test is a single
 * expression in each. Pinning the expression is what stops it regressing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..", "..", "..", "..");
const IMPORT_ROUTE = readFileSync(resolve(root, "src/app/api/admin/import/route.ts"), "utf8");
const IMPORT_URL_ROUTE = readFileSync(
  resolve(root, "src/app/api/admin/import-url/route.ts"),
  "utf8"
);
const SCHEMA = readFileSync(resolve(root, "packages/db-schema/src/index.ts"), "utf8");

describe("the importers no longer equate presence with confirmation", () => {
  it("/api/admin/import does not derive confirmation from startDate", () => {
    expect(IMPORT_ROUTE).not.toContain("eventData.startDate ? true : false");
    expect(IMPORT_ROUTE).toContain("datesConfirmed: eventData.datesConfirmed ?? false");
  });

  it("/api/admin/import-url does not derive confirmation from startDate", () => {
    expect(IMPORT_URL_ROUTE).not.toContain(
      "datesConfirmed: event.datesConfirmed ?? startDate !== null"
    );
    expect(IMPORT_URL_ROUTE).toContain("datesConfirmed: event.datesConfirmed ?? false");
  });

  it("still lets an explicit caller claim confirmation", () => {
    // The fix must not make confirmation unreachable — a caller that KNOWS
    // (an organizer reply, a human check) has to be able to say so.
    expect(IMPORT_ROUTE).toContain("eventData.datesConfirmed ??");
    expect(IMPORT_URL_ROUTE).toContain("event.datesConfirmed ??");
  });
});

describe("the DDL defaults are opt-in", () => {
  it("dates_confirmed defaults to false", () => {
    expect(SCHEMA).toContain(
      'datesConfirmed: integer("dates_confirmed", { mode: "boolean" }).default(false)'
    );
  });

  it("sync_enabled defaults to false", () => {
    // Clobber permission. Granting it by default let an importer overwrite a
    // promoter's own listing.
    expect(SCHEMA).toContain(
      'syncEnabled: integer("sync_enabled", { mode: "boolean" }).default(false)'
    );
  });
});

describe("the reference lanes are unchanged", () => {
  it("annual_rollover still declines to claim confirmation", () => {
    // 121 events, exactly 1 confirmed — the behaviour the ticket calls the
    // reference implementation. If this flips, the yardstick is gone.
    const rollover = readFileSync(resolve(root, "mcp-server/src/event-rollover.ts"), "utf8");
    expect(rollover).toContain("datesConfirmed: false");
  });

  it("the vendor create tool still declines", () => {
    const vendor = readFileSync(resolve(root, "mcp-server/src/tools/vendor.ts"), "utf8");
    expect(vendor).toContain("datesConfirmed: false");
  });
});
