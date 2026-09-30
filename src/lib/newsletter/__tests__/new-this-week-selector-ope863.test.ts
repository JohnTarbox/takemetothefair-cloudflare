/**
 * OPE-863 — the vendor-digest selector's WHERE clause, against a real database.
 *
 * ## Why this file exists separately from new-this-week.test.ts
 *
 * That file opens by saying the past-date guard "is the load-bearing bit", pins
 * `startOfUtcDay`, `weekAgo` and `datesAreUnconfirmed`, and then says: *"The
 * full query is exercised in integration; these lock the pure boundaries the
 * SQL is built from."*
 *
 * Every one of those assertions was true and passing on 2026-09-09, when the
 * digest mailed vendors an "Apply for a booth →" button for a show that had
 * happened three days earlier. **The boundaries were correct. Their composition
 * was not** — a second arm of the `or()` had no date test at all and routed
 * straight around the guard the other file pins so carefully.
 *
 * A helper-level test cannot see that, by construction. So these run the actual
 * query against an in-memory SQLite, following the OPE-424 pattern in
 * `src/lib/events/__tests__/source-reachability.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { selectNewThisWeekEvents } from "../new-this-week";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    status TEXT NOT NULL, lifecycle_status TEXT,
    start_date INTEGER, end_date INTEGER, dates_confirmed INTEGER,
    categories TEXT, commercial_vendors_allowed INTEGER,
    estimated_attendance INTEGER, event_scale TEXT, indoor_outdoor TEXT,
    application_url TEXT, source_url TEXT,
    promoter_id TEXT, possible_duplicate_of TEXT, merged_into TEXT,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY, name TEXT, website TEXT,
    created_at INTEGER, updated_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

/** The moment the real 09-09 digest was composed. */
const NOW = new Date("2026-09-09T02:05:00Z");
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** Inside the "added in the last 7 days" window, for every fixture. */
const CREATED = T("2026-09-08T00:00:00Z");

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seed(
  id: string,
  opts: {
    status?: string;
    lifecycle?: string | null;
    start?: string | null;
    dup?: string | null;
    merged?: string | null;
  } = {}
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, lifecycle_status, start_date,
         dates_confirmed, categories, possible_duplicate_of, merged_into, created_at, updated_at)
       VALUES (?,?,?,?,?,?,1,'[]',?,?,?,?)`
    )
    .run(
      id,
      `Event ${id}`,
      `event-${id}`,
      opts.status ?? "APPROVED",
      opts.lifecycle === undefined ? "SCHEDULED" : opts.lifecycle,
      opts.start === undefined ? T("2026-10-01T12:00:00Z") : opts.start ? T(opts.start) : null,
      opts.dup ?? null,
      opts.merged ?? null,
      CREATED,
      CREATED
    );
}

const slugs = async () => (await selectNewThisWeekEvents(db, NOW)).map((e) => e.slug);

describe("OPE-863 — the dateless escape hatch requires a NULL start_date", () => {
  it("REGRESSION: a TENTATIVE/TENTATIVE show whose date has passed is not selected", () => {
    // The real specimen. milford-porchfest-east-shore-2026 led the 09-09 issue:
    // TENTATIVE/TENTATIVE, start_date 2026-09-06 12:00Z — three days before the
    // send — and NOT NULL, so it failed the real guard and passed the hatch.
    seed("milford", {
      status: "TENTATIVE",
      lifecycle: "TENTATIVE",
      start: "2026-09-06T12:00:00Z",
    });
    return expect(slugs()).resolves.toEqual([]);
  });

  it("a TENTATIVE/TENTATIVE show with NO date IS still selected", async () => {
    // The other half, and the one a careless fix breaks. Deleting the whole
    // branch satisfies the assertion above and silently drops the 7 real
    // dateless rows the branch exists for.
    seed("dateless", { status: "TENTATIVE", lifecycle: "TENTATIVE", start: null });
    await expect(slugs()).resolves.toEqual(["event-dateless"]);
  });

  it("both at once — the fix must separate them, not collapse them", async () => {
    // Positive landmark: 2 candidates in the table, exactly 1 selected. An
    // empty result and a full result each satisfy one of the two tests above;
    // only this one pins the boundary between them.
    seed("past", { status: "TENTATIVE", lifecycle: "TENTATIVE", start: "2026-09-06T12:00:00Z" });
    seed("dateless", { status: "TENTATIVE", lifecycle: "TENTATIVE", start: null });

    expect(raw.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 2 });
    await expect(slugs()).resolves.toEqual(["event-dateless"]);
  });

  it("a future-dated show is unaffected, by either arm", async () => {
    seed("future-appr", { start: "2026-10-01T12:00:00Z" });
    seed("future-tent", {
      status: "TENTATIVE",
      lifecycle: "TENTATIVE",
      start: "2026-10-02T12:00:00Z",
    });
    const got = await slugs();
    expect(got).toHaveLength(2);
    expect(got).toEqual(expect.arrayContaining(["event-future-appr", "event-future-tent"]));
  });

  it("an event starting earlier TODAY still counts — the boundary is the DAY", async () => {
    // startOfUtcDay, exercised through the real query rather than in isolation.
    // NOW is 2026-09-09T02:05Z; this starts at 00:30Z the same day.
    seed("today", { start: "2026-09-09T00:30:00Z" });
    await expect(slugs()).resolves.toEqual(["event-today"]);
  });

  it("an APPROVED show with no date is still excluded — a data gap, not an opportunity", async () => {
    seed("appr-dateless", { status: "APPROVED", lifecycle: "SCHEDULED", start: null });
    await expect(slugs()).resolves.toEqual([]);
  });
});

describe("OPE-863 — flagged duplicates and tombstones never reach the list", () => {
  it("a row with possible_duplicate_of set is not selected", async () => {
    // brookfield-orchards-harvest-craft-fair-2 was the ONLY live flagged
    // duplicate in the table (1 of 2,004) and it is the one that went out.
    seed("brookfield2", { start: "2026-09-12T12:00:00Z", dup: "c1e8273c" });
    await expect(slugs()).resolves.toEqual([]);
  });

  it("the duplicate's healthy original is still selected", async () => {
    // Positive landmark against an over-broad filter: excluding the flagged row
    // must not exclude the row it points at.
    seed("brookfield1", { start: "2026-09-12T12:00:00Z" });
    seed("brookfield2", { start: "2026-09-12T12:00:00Z", dup: "brookfield1" });
    await expect(slugs()).resolves.toEqual(["event-brookfield1"]);
  });

  it("a merged tombstone is not selected", async () => {
    // ⚠️ Honest note: this guard is INERT in production today. `merge_events`
    // sets the tombstone to REJECTED, which the status filter already excludes,
    // so no live row reaches this condition. It is kept because the coupling is
    // invisible — a future change to what merge writes would silently start
    // mailing redirect rows — but it fixes no live leak and must not be
    // credited with one. The fixture below is deliberately APPROVED, i.e. a
    // state production does not currently produce.
    seed("tombstone", { start: "2026-10-01T12:00:00Z", merged: "keeper-id" });
    await expect(slugs()).resolves.toEqual([]);
  });
});

describe("OPE-863 — the pre-existing filters still hold", () => {
  it("an event added more than 7 days ago is not 'new this week'", async () => {
    seed("old", { start: "2026-10-01T12:00:00Z" });
    raw.prepare("UPDATE events SET created_at = ? WHERE id = 'old'").run(T("2026-08-01T00:00:00Z"));
    await expect(slugs()).resolves.toEqual([]);
  });

  it.each(["REJECTED", "PENDING", "DRAFT"])("status %s is excluded", async (status) => {
    seed("x", { status, start: "2026-10-01T12:00:00Z" });
    await expect(slugs()).resolves.toEqual([]);
  });

  it("orders soonest-first so the strongest time pressure leads", async () => {
    seed("late", { start: "2026-12-01T12:00:00Z" });
    seed("soon", { start: "2026-09-20T12:00:00Z" });
    seed("mid", { start: "2026-10-15T12:00:00Z" });
    await expect(slugs()).resolves.toEqual(["event-soon", "event-mid", "event-late"]);
  });

  it("a dateless show sorts LAST, after every dated one", async () => {
    seed("dateless", { status: "TENTATIVE", lifecycle: "TENTATIVE", start: null });
    seed("dated", { start: "2026-12-01T12:00:00Z" });
    await expect(slugs()).resolves.toEqual(["event-dated", "event-dateless"]);
  });
});
