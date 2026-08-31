/**
 * OPE-709 — the `event_applications` backfill, run as the real migration file.
 *
 * The test executes `drizzle/0257_ope709_event_applications.sql` verbatim rather
 * than a restatement of it, so the assertions cannot drift from what actually
 * ships. That matters more than usual here: this is a DATA migration, and a data
 * migration is the one kind whose bugs are not visible in a diff.
 *
 * Two properties are load-bearing:
 *
 *  1. It must be a NO-OP on an empty database. CI applies every migration to a
 *     fresh D1, and a data migration that assumes rows aborts the whole run.
 *     Written as INSERT ... SELECT ... FROM events, so this holds by
 *     construction — but "by construction" is exactly the kind of claim that is
 *     worth one assertion.
 *  2. The 105 existing commercial-vendor routes must survive intact, because the
 *     public "Vendor Applications" section is the only application information
 *     105 events have. Losing one is a worse outcome than the gap this ticket
 *     exists to close.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(
  join(__dirname, "..", "..", "..", "drizzle", "0257_ope709_event_applications.sql"),
  "utf8"
);

// The columns the migration touches, in the shape prod has them.
const EVENTS_DDL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT,
    application_url TEXT,
    application_instructions TEXT,
    application_deadline INTEGER,
    merged_into TEXT
  );
`;

let db: InstanceType<typeof Database>;

function seedEvent(
  id: string,
  url: string | null,
  opts: {
    instructions?: string | null;
    deadline?: number | null;
    merged?: string | null;
    status?: string;
  } = {}
) {
  db.prepare(
    `INSERT INTO events (id, name, status, application_url, application_instructions, application_deadline, merged_into)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    id,
    id,
    opts.status ?? "APPROVED",
    url,
    opts.instructions ?? null,
    opts.deadline ?? null,
    opts.merged ?? null
  );
}

const rows = () =>
  db.prepare(`SELECT * FROM event_applications ORDER BY event_id`).all() as Array<
    Record<string, unknown>
  >;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(EVENTS_DDL);
});

describe("it is a no-op on an empty database", () => {
  it("applies cleanly and inserts nothing", () => {
    expect(() => db.exec(MIGRATION)).not.toThrow();
    expect(rows()).toHaveLength(0);
  });
});

describe("the 105 commercial-vendor routes migrate intact", () => {
  it("carries the URL, instructions and deadline onto one commercial_vendor row", () => {
    // 1772280000 = 2026-02-28 12:00:00Z — real prod value, seconds, noon-anchored.
    seedEvent("e1", "https://fair.example.org/vendor-application", {
      instructions: "Booths are $250. Apply by February.",
      deadline: 1772280000,
    });
    db.exec(MIGRATION);

    const [r] = rows();
    expect(r.lane).toBe("commercial_vendor");
    expect(r.url).toBe("https://fair.example.org/vendor-application");
    expect(r.notes).toBe("Booths are $250. Apply by February.");
    // Seconds in, seconds out. A *1000 here would silently push every deadline
    // to the year 58000 and match nothing.
    expect(r.closes_at).toBe(1772280000);
    expect(r.department).toBeNull();
  });

  it("leaves the dates NULL when the event has none — the common case", () => {
    seedEvent("e1", "https://fair.example.org/apply");
    db.exec(MIGRATION);
    const [r] = rows();
    expect(r.closes_at).toBeNull();
    expect(r.opens_at).toBeNull();
  });

  it("never invents a deadline from anything", () => {
    // The rule the ruling insisted on: The Big E's photography closed in June for
    // a September fair; Topsfield's closes five days before theirs. If a future
    // edit defaults closes_at, this fails.
    seedEvent("e1", "https://fair.example.org/apply", { deadline: null });
    db.exec(MIGRATION);
    expect(rows()[0].closes_at).toBeNull();
  });

  it("stores empty instructions as NULL, not as an empty string", () => {
    seedEvent("e1", "https://fair.example.org/apply", { instructions: "   " });
    db.exec(MIGRATION);
    expect(rows()[0].notes).toBeNull();
  });

  it("skips merge tombstones", () => {
    seedEvent("dead", "https://fair.example.org/apply", { merged: "keeper" });
    db.exec(MIGRATION);
    expect(rows()).toHaveLength(0);
  });

  it("migrates a PENDING or REJECTED event's route too — status is not the filter", () => {
    // The lane is a property of the route, not of the event's editorial state.
    // Filtering on APPROVED here would silently drop 7 of the 105.
    seedEvent("p", "https://fair.example.org/apply", { status: "PENDING" });
    db.exec(MIGRATION);
    expect(rows()).toHaveLength(1);
  });
});

describe("the two mailto: routes become contact_email, not url", () => {
  it("strips the scheme and stores the address", () => {
    seedEvent("m1", "mailto:secretary@waterville905.com");
    db.exec(MIGRATION);
    const [r] = rows();
    expect(r.contact_email).toBe("secretary@waterville905.com");
    expect(r.url).toBeNull();
    expect(r.lane).toBe("commercial_vendor");
  });

  it("does not also create a url row for the same event", () => {
    // Both INSERTs run over the same table; a mailto must match exactly one.
    seedEvent("m1", "mailto:a@b.com");
    db.exec(MIGRATION);
    expect(rows()).toHaveLength(1);
  });

  it("ignores a bare `mailto:` with no address", () => {
    seedEvent("m1", "mailto:");
    db.exec(MIGRATION);
    expect(rows()).toHaveLength(0);
  });
});

describe("the two junk values are cleaned, not carried", () => {
  it("drops the example.com placeholder and clears it from events", () => {
    seedEvent("j1", "https://example.com/application", { status: "REJECTED" });
    db.exec(MIGRATION);
    expect(rows()).toHaveLength(0);
    expect(
      (
        db.prepare(`SELECT application_url FROM events WHERE id='j1'`).get() as {
          application_url: string | null;
        }
      ).application_url
    ).toBeNull();
  });

  it("drops the MailerLite click-tracker and clears it", () => {
    const tracker = "https://click.mlsend.com/link/c/YT0zMDc5Mjg1ODA1MTg1NzY4MDI0.v-2-p926";
    seedEvent("j2", tracker, { status: "PENDING" });
    db.exec(MIGRATION);
    expect(rows()).toHaveLength(0);
    expect(
      (
        db.prepare(`SELECT application_url FROM events WHERE id='j2'`).get() as {
          application_url: string | null;
        }
      ).application_url
    ).toBeNull();
  });

  it("does NOT clear a legitimate URL that merely mentions the domain", () => {
    // The cleanup is scoped by exact value / full prefix, not by substring, so a
    // real page cannot be nulled by accident.
    const real = "https://myfair.org/vendors?ref=example.compare";
    seedEvent("ok", real);
    db.exec(MIGRATION);
    expect(
      (
        db.prepare(`SELECT application_url FROM events WHERE id='ok'`).get() as {
          application_url: string;
        }
      ).application_url
    ).toBe(real);
    expect(rows()).toHaveLength(1);
  });
});

describe("the whole-lane uniqueness rule", () => {
  it("refuses a second whole-lane row for the same event and lane", () => {
    seedEvent("e1", "https://fair.example.org/apply");
    db.exec(MIGRATION);
    expect(() =>
      db
        .prepare(
          `INSERT INTO event_applications (id, event_id, lane, url, created_at, updated_at)
           VALUES ('x','e1','commercial_vendor','https://other',1,1)`
        )
        .run()
    ).toThrow(/UNIQUE/i);
  });

  it("allows many DEPARTMENT rows in the same lane", () => {
    // Topsfield has five, with deadlines 28 days apart. If this ever throws, the
    // index has been widened and the whole reason (c) beat (b) is gone.
    seedEvent("e1", null);
    db.exec(MIGRATION);
    for (const [i, dept] of ["Farm Photography", "Fine Arts", "Cattle"].entries()) {
      db.prepare(
        `INSERT INTO event_applications (id, event_id, lane, department, url, created_at, updated_at)
         VALUES (?,?,?,?,?,1,1)`
      ).run(`d${i}`, "e1", "exhibitor_competition", dept, "https://fairentry.com/x");
    }
    expect(rows()).toHaveLength(3);
  });

  it("still allows one whole-lane row per DIFFERENT lane", () => {
    seedEvent("e1", "https://fair.example.org/apply");
    db.exec(MIGRATION);
    expect(() =>
      db
        .prepare(
          `INSERT INTO event_applications (id, event_id, lane, url, created_at, updated_at)
           VALUES ('x','e1','exhibitor_competition','https://fairentry.com/x',1,1)`
        )
        .run()
    ).not.toThrow();
  });
});

describe("the FK is real", () => {
  it("cascades on event delete", () => {
    db.exec(MIGRATION);
    db.pragma("foreign_keys = ON");
    seedEvent("e1", null);
    db.prepare(
      `INSERT INTO event_applications (id, event_id, lane, url, created_at, updated_at)
       VALUES ('a1','e1','exhibitor_competition','https://x',1,1)`
    ).run();
    db.prepare(`DELETE FROM events WHERE id='e1'`).run();
    expect(rows()).toHaveLength(0);
  });
});

/**
 * Acceptance: "The public Vendor Applications section renders identically for
 * those 105 events. Regression-check this explicitly."
 *
 * It renders identically because it was not touched — the new lanes are an
 * ADDITIVE section reading a different source. That is a decision, not an
 * accident, and this block is what stops a later edit from "unifying" them:
 * re-pointing the vendor block at `event_applications` would put 105 live pages
 * at risk to gain nothing, since the legacy columns still hold every one of
 * those routes.
 *
 * Source-level assertions, because the page is a server component with a live DB
 * dependency. They are narrow on purpose: each pins one fact that would have to
 * change for the regression to happen.
 */
describe("the public vendor section is untouched", () => {
  const page = readFileSync(
    join(__dirname, "..", "..", "app", "events", "[slug]", "page.tsx"),
    "utf8"
  );

  it("still gates the Vendor Applications block on the legacy columns", () => {
    expect(page).toMatch(/event\.applicationDeadline\s*\|\|\s*\n?\s*event\.applicationUrl/);
    expect(page).toContain("Vendor Applications");
    expect(page).toContain("Apply Now →");
  });

  it("does not gate the vendor block on the new table", () => {
    // If `applicationRoutes` ever appears inside the vendor block's condition,
    // an event with no rows in the new table would lose its existing section.
    const vendorIdx = page.indexOf("Vendor Applications");
    const windowBefore = page.slice(Math.max(0, vendorIdx - 600), vendorIdx);
    expect(windowBefore).not.toContain("applicationRoutes");
  });

  it("renders the new lanes as a separate section keyed on the new source", () => {
    expect(page).toContain("Exhibitor &amp; Competition Entries");
    expect(page).toMatch(/event\.applicationRoutes\?\.length > 0/);
  });

  it("never derives an entry deadline from the event's own dates", () => {
    // The rule the ruling insisted on. If a future edit reaches for
    // `event.startDate` inside the new section, this fails.
    const start = page.indexOf("Exhibitor &amp; Competition Entries");
    const section = page.slice(start, start + 2400);
    expect(section).not.toMatch(/event\.startDate|event\.endDate/);
    expect(section).toContain("route.closesAt");
  });
});

describe("the admin reader lands before any writer (hazard 4)", () => {
  const reader = readFileSync(
    join(__dirname, "..", "..", "..", "mcp-server", "src", "tools", "admin-event-read.ts"),
    "utf8"
  );

  it("selects every lane, unfiltered", () => {
    // `application_url` shipped invisible to this tool until OPE-534 noticed. A
    // lane the admin reader cannot see is a lane nobody can verify was written
    // correctly — and an absent lane is indistinguishable from an empty one.
    expect(reader).toMatch(/\.from\(eventApplications\)/);
    expect(reader).toContain("applications: applications.map(");
    // No lane predicate on the admin read.
    const q = reader.slice(reader.indexOf(".from(eventApplications)"));
    expect(q.slice(0, 300)).not.toContain("lane,");
  });

  it("exposes contact_email, so a mailto route is not invisible", () => {
    expect(reader).toContain("contact_email: a.contactEmail");
  });
});
