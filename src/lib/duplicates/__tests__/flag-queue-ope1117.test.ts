/**
 * OPE-1117 — the consumer for `possible_duplicate_of`.
 *
 * Fixtures are the REAL eight flagged rows on prod D1 (2026-09-23), with their
 * real statuses, resolution columns and dates. The acceptance is stated against
 * that data: the queue lists exactly `77b95478` and `bd1b1f4c`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import {
  assessDuplicateFlagDeadlines,
  assessAllDuplicateFlagDeadlines,
  dismissDuplicateFlag,
  dismissedFlagIds,
  listUnresolvedDuplicateFlags,
  loadDuplicateFlagFlow,
  loadUnresolvedFlagForEvent,
  rejectFlaggedAsDuplicate,
  DUPLICATE_FLAG_ALERT_DAYS_KEY,
} from "../flag-queue";
import { detectPossibleDuplicate } from "../venue-date-collision";
import { CENSUS } from "./fixtures-ope627-census";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'APPROVED',
    venue_id TEXT,
    promoter_id TEXT,
    start_date INTEGER,
    end_date INTEGER,
    source_name TEXT,
    source_url TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    merged_into TEXT,
    possible_duplicate_of TEXT,
    rejected_as_duplicate_of TEXT
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT,
    state TEXT
  );
  CREATE TABLE event_duplicate_dismissals (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    dismissed_by TEXT,
    dismissed_at INTEGER NOT NULL,
    note TEXT
  );
  CREATE UNIQUE INDEX uq_pair ON event_duplicate_dismissals (event_id, candidate_id);
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE tunable_thresholds (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL,
    reason TEXT,
    updated_at INTEGER
  );
`;

const sec = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000);
const NOW = new Date("2026-09-23T13:00:00Z");

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

interface Seed {
  id: string;
  slug: string;
  status: string;
  start: string;
  created: string;
  flag?: string | null;
  merged?: string | null;
  rejDup?: string | null;
}

function seedEvent(s: Seed) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, start_date, end_date, created_at, updated_at,
                           merged_into, possible_duplicate_of, rejected_as_duplicate_of)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      s.id,
      s.slug,
      s.slug,
      s.status,
      sec(s.start),
      sec(s.start),
      sec(s.created),
      sec(s.created),
      s.merged ?? null,
      s.flag ?? null,
      s.rejDup ?? null
    );
}

/** The keepers the eight flags point at. */
const KEEPERS: Seed[] = [
  {
    id: "defe4089",
    slug: "new-england-made-giftware-specialty-food-show-autumn",
    status: "APPROVED",
    start: "2026-09-15",
    created: "2026-06-01",
  },
  {
    id: "5f917800",
    slug: "vermont-crafters-expo",
    status: "APPROVED",
    start: "2026-11-07",
    created: "2026-06-01",
  },
  {
    id: "c1e8273c",
    slug: "brookfield-orchards-harvest-craft-fair",
    status: "APPROVED",
    start: "2026-09-12",
    created: "2026-06-01",
  },
  {
    id: "9cc2ecc9",
    slug: "falling-leaves-craft-fair-at-tanger",
    status: "APPROVED",
    start: "2026-09-19",
    created: "2026-06-01",
  },
  {
    id: "72137786",
    slug: "hackmatack-open-farm-days-jubilee-festival-2026",
    status: "APPROVED",
    start: "2026-06-21",
    created: "2026-06-01",
  },
  {
    id: "ac556d07",
    slug: "hackmatack-open-farm-days-fall-fest-2026",
    status: "APPROVED",
    start: "2026-10-11",
    created: "2026-06-01",
  },
];

/** The eight flagged rows, exactly as prod D1 held them on 2026-09-23. */
const FLAGGED: Seed[] = [
  {
    id: "38c8371b",
    slug: "new-england-made-autumn-show-2026-merged-38c8371b",
    status: "REJECTED",
    start: "2026-09-15",
    created: "2026-07-28",
    flag: "defe4089",
    merged: "defe4089",
  },
  {
    id: "5628da1c",
    slug: "new-england-made-autumn-show-2026-2-merged-5628da1c",
    status: "REJECTED",
    start: "2026-09-15",
    created: "2026-08-17",
    flag: "defe4089",
    merged: "defe4089",
  },
  {
    id: "ea4fcb63",
    slug: "vermont-crafters-expo-2-merged-ea4fcb63",
    status: "REJECTED",
    start: "2026-11-07",
    created: "2026-08-24",
    flag: "5f917800",
    merged: "5f917800",
  },
  {
    id: "77b95478",
    slug: "brookfield-orchards-harvest-craft-fair-2",
    status: "TENTATIVE",
    start: "2026-09-12",
    created: "2026-09-05",
    flag: "c1e8273c",
  },
  {
    id: "bd1b1f4c",
    slug: "lakes-region-fall-craft-fair",
    status: "PENDING",
    start: "2026-09-19",
    created: "2026-09-18",
    flag: "9cc2ecc9",
  },
  {
    id: "0382ba77",
    slug: "hackmatack-open-farm-day",
    status: "REJECTED",
    start: "2026-06-21",
    created: "2026-09-21",
    flag: "72137786",
    rejDup: "72137786",
  },
  {
    id: "4ec8c634",
    slug: "hackmatack-fall-festival",
    status: "REJECTED",
    start: "2026-10-11",
    created: "2026-09-21",
    flag: "ac556d07",
    rejDup: "ac556d07",
  },
  {
    id: "f3c8c646",
    slug: "hackmatack-fall-fest",
    status: "REJECTED",
    start: "2026-10-11",
    created: "2026-09-21",
    flag: "4ec8c634",
    rejDup: "4ec8c634",
  },
];

const eventsSnapshot = () => raw.prepare(`SELECT * FROM events ORDER BY id`).all();

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  for (const s of [...KEEPERS, ...FLAGGED]) seedEvent(s);
});

const ids = async () =>
  (await listUnresolvedDuplicateFlags(db as never, NOW)).map((f) => f.flagged.id).sort();

describe("the unresolved-flag queue, over prod's real eight rows", () => {
  it("lists exactly the two rows the ticket names", async () => {
    // Positive landmark beside the assertion: eight flagged rows were examined.
    const flaggedCount = raw
      .prepare(`SELECT count(*) n FROM events WHERE possible_duplicate_of IS NOT NULL`)
      .get() as { n: number };
    expect(flaggedCount.n).toBe(8);
    expect(await ids()).toEqual(["77b95478", "bd1b1f4c"]);
  });

  it("pairs each flag with its keeper, soonest event first", async () => {
    const flags = await listUnresolvedDuplicateFlags(db as never, NOW);
    expect(flags.map((f) => [f.flagged.id, f.candidate?.id])).toEqual([
      ["77b95478", "c1e8273c"],
      ["bd1b1f4c", "9cc2ecc9"],
    ]);
    // Both events have already happened — which is the failure being fixed.
    expect(flags.map((f) => f.daysUntilStart)).toEqual([-11, -4]);
  });

  it("exposes the flag to a single-event read, and hides a resolved one", async () => {
    expect((await loadUnresolvedFlagForEvent(db as never, "bd1b1f4c"))?.slug).toBe(
      "falling-leaves-craft-fair-at-tanger"
    );
    expect(await loadUnresolvedFlagForEvent(db as never, "0382ba77")).toBeNull(); // rejected as dup
    expect(await loadUnresolvedFlagForEvent(db as never, "38c8371b")).toBeNull(); // merged
    expect(await loadUnresolvedFlagForEvent(db as never, "c1e8273c")).toBeNull(); // never flagged
  });
});

describe("dismissal — its own record, never an events column", () => {
  it("takes the pair out of the queue and writes neither duplicate column", async () => {
    const before = raw
      .prepare(
        `SELECT possible_duplicate_of, rejected_as_duplicate_of, status FROM events WHERE id = 'bd1b1f4c'`
      )
      .get();

    const res = await dismissDuplicateFlag(db as never, {
      eventId: "bd1b1f4c",
      candidateId: "9cc2ecc9",
      actorUserId: "admin-1",
      note: "different organizer",
      now: NOW,
    });
    expect(res).toEqual({ ok: true });

    const after = raw
      .prepare(
        `SELECT possible_duplicate_of, rejected_as_duplicate_of, status FROM events WHERE id = 'bd1b1f4c'`
      )
      .get();
    expect(after).toEqual(before);
    expect(await ids()).toEqual(["77b95478"]);

    const audit = raw.prepare(`SELECT action, target_id FROM admin_actions`).all();
    expect(audit).toEqual([{ action: "event.duplicate_flag.dismiss", target_id: "bd1b1f4c" }]);
  });

  it("stays dismissed — a repeat dismissal is refused and the row does not return", async () => {
    const input = { eventId: "bd1b1f4c", candidateId: "9cc2ecc9", actorUserId: null, now: NOW };
    await dismissDuplicateFlag(db as never, input);
    // A second click on a stale page is refused rather than double-recorded.
    expect(await dismissDuplicateFlag(db as never, input)).toEqual({
      ok: false,
      reason: "already_resolved",
    });
    expect(
      (raw.prepare(`SELECT count(*) n FROM event_duplicate_dismissals`).get() as { n: number }).n
    ).toBe(1);
    expect((raw.prepare(`SELECT count(*) n FROM admin_actions`).get() as { n: number }).n).toBe(1);
    expect(await ids()).toEqual(["77b95478"]);
    expect([...(await dismissedFlagIds(db as never, ["bd1b1f4c", "77b95478"]))]).toEqual([
      "bd1b1f4c",
    ]);
  });

  it("is keyed on the PAIR: a re-flag against a different candidate re-enters the queue", async () => {
    await dismissDuplicateFlag(db as never, {
      eventId: "bd1b1f4c",
      candidateId: "9cc2ecc9",
      actorUserId: null,
      now: NOW,
    });
    raw.prepare(`UPDATE events SET possible_duplicate_of = 'c1e8273c' WHERE id = 'bd1b1f4c'`).run();
    expect(await ids()).toEqual(["77b95478", "bd1b1f4c"]);
    expect(await dismissedFlagIds(db as never, ["bd1b1f4c"])).toEqual(new Set());
  });

  it("refuses a verdict on a pair the operator did not see", async () => {
    expect(
      await dismissDuplicateFlag(db as never, {
        eventId: "bd1b1f4c",
        candidateId: "c1e8273c",
        actorUserId: null,
      })
    ).toEqual({ ok: false, reason: "candidate_mismatch" });
    expect(
      await dismissDuplicateFlag(db as never, {
        eventId: "0382ba77",
        candidateId: "72137786",
        actorUserId: null,
      })
    ).toEqual({ ok: false, reason: "already_resolved" });
    expect(
      await dismissDuplicateFlag(db as never, {
        eventId: "c1e8273c",
        candidateId: "x",
        actorUserId: null,
      })
    ).toEqual({ ok: false, reason: "not_flagged" });
    expect(
      await dismissDuplicateFlag(db as never, {
        eventId: "nope",
        candidateId: "x",
        actorUserId: null,
      })
    ).toEqual({ ok: false, reason: "not_found" });
    expect(raw.prepare(`SELECT count(*) n FROM event_duplicate_dismissals`).get()).toEqual({
      n: 0,
    });
  });
});

describe("reject as duplicate — the OPE-450 adjudication, written explicitly", () => {
  it("REJECTs the row naming the keeper, and it leaves the queue", async () => {
    const res = await rejectFlaggedAsDuplicate(db as never, {
      eventId: "77b95478",
      candidateId: "c1e8273c",
      actorUserId: "admin-1",
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(
      raw
        .prepare(
          `SELECT status, rejected_as_duplicate_of, merged_into FROM events WHERE id = '77b95478'`
        )
        .get()
    ).toEqual({ status: "REJECTED", rejected_as_duplicate_of: "c1e8273c", merged_into: null });
    expect(await ids()).toEqual(["bd1b1f4c"]);
  });
});

describe("the deadline alert — age against the EVENT, not queue depth", () => {
  it("fires today on both real misses, naming the soonest", async () => {
    const reds = await assessAllDuplicateFlagDeadlines(db as never, NOW);
    expect(reds).toHaveLength(1);
    expect(reds[0].refKey).toBe("duplicate-flags:unread-near-event");
    expect(reds[0].title).toContain("2 flagged events");
    expect(reds[0].title).toContain("brookfield-orchards-harvest-craft-fair-2");
    expect(reds[0].title).toContain("started 11d ago");
  });

  it("would have fired on bd1b1f4c the day it was flagged — the day before its fair", async () => {
    const flaggedDay = new Date("2026-09-18T15:00:00Z");
    raw.prepare(`UPDATE events SET possible_duplicate_of = NULL WHERE id = '77b95478'`).run();
    const red = assessDuplicateFlagDeadlines(
      await listUnresolvedDuplicateFlags(db as never, flaggedDay),
      flaggedDay
    );
    expect(red?.title).toContain("lakes-region-fall-craft-fair (PENDING, starts in 1d)");
  });

  it("stays silent for a flag whose event is further out than the horizon", async () => {
    const early = new Date("2026-08-01T12:00:00Z");
    expect(
      assessDuplicateFlagDeadlines(await listUnresolvedDuplicateFlags(db as never, early), early)
    ).toBeNull();
  });

  it("honours the operator horizon from tunable_thresholds", async () => {
    const early = new Date("2026-08-01T12:00:00Z"); // bd1b1f4c is 49d out, 77b95478 is 42d
    raw
      .prepare(`INSERT INTO tunable_thresholds (key, value) VALUES (?, ?)`)
      .run(DUPLICATE_FLAG_ALERT_DAYS_KEY, 45);
    const reds = await assessAllDuplicateFlagDeadlines(db as never, early);
    expect(reds).toHaveLength(1);
    expect(reds[0].title).toContain("1 flagged event starting within 45d");
  });

  it("goes quiet once both are adjudicated", async () => {
    await dismissDuplicateFlag(db as never, {
      eventId: "bd1b1f4c",
      candidateId: "9cc2ecc9",
      actorUserId: null,
    });
    await rejectFlaggedAsDuplicate(db as never, {
      eventId: "77b95478",
      candidateId: "c1e8273c",
      actorUserId: null,
    });
    expect(await assessAllDuplicateFlagDeadlines(db as never, NOW)).toEqual([]);
  });
});

describe("drain-tile inputs", () => {
  it("counts the open depth and the week's flow", async () => {
    const f = await loadDuplicateFlagFlow(db as never, NOW);
    expect(f.depth).toBe(2);
    // Flagged in the last 7d: the three Hackmatack rows (Sep 21) and bd1b1f4c (Sep 18).
    expect(f.inflow7d).toBe(4);
    // Left the queue in the last 7d: the three Hackmatack rejections.
    expect(f.outflow7d).toBe(3);
    expect(f.oldestOpenAt?.toISOString().slice(0, 10)).toBe("2026-09-05");
  });

  it("counts a dismissal as outflow", async () => {
    await dismissDuplicateFlag(db as never, {
      eventId: "bd1b1f4c",
      candidateId: "9cc2ecc9",
      actorUserId: null,
      now: NOW,
    });
    const f = await loadDuplicateFlagFlow(db as never, NOW);
    expect(f.depth).toBe(1);
    expect(f.outflow1d).toBe(1);
  });
});

describe("OPE-627's ten-pair census — listing is fine, merging is a fail", () => {
  it("running the whole queue over the census leaves the events table byte-identical", async () => {
    raw.exec(`DELETE FROM events`);
    for (const r of CENSUS) {
      seedEvent({
        id: r.slug,
        slug: r.slug,
        status: r.status ?? "APPROVED",
        start: r.start,
        created: "2026-08-29",
      });
      raw
        .prepare(`UPDATE events SET venue_id = ?, promoter_id = ?, end_date = ? WHERE id = ?`)
        .run(r.venue, r.promoter, sec(r.end), r.slug);
    }
    // Flag the census the way intake does: each row against what the detector names.
    let flagged = 0;
    for (const r of CENSUS) {
      const hit = await detectPossibleDuplicate(db as never, {
        venueId: r.venue,
        startDate: new Date(`${r.start}T12:00:00Z`),
        endDate: new Date(`${r.end}T12:00:00Z`),
        name: r.name,
        promoterId: r.promoter,
        excludeEventId: r.slug,
      });
      if (hit) {
        raw.prepare(`UPDATE events SET possible_duplicate_of = ? WHERE id = ?`).run(hit, r.slug);
        flagged++;
      }
    }
    // Landmark: the census really does produce flags, so the assertion below is not vacuous.
    expect(flagged).toBeGreaterThan(0);

    const before = eventsSnapshot();
    const listed = await listUnresolvedDuplicateFlags(db as never, NOW);
    await loadDuplicateFlagFlow(db as never, NOW);
    await assessAllDuplicateFlagDeadlines(db as never, NOW);
    await dismissedFlagIds(
      db as never,
      listed.map((f) => f.flagged.id)
    );

    expect(listed.length).toBe(flagged);
    expect(eventsSnapshot()).toEqual(before);
    expect(
      raw.prepare(`SELECT count(*) n FROM events WHERE merged_into IS NOT NULL`).get()
    ).toEqual({ n: 0 });
  });
});

describe("wiring — the consumer is only a consumer if something calls it", () => {
  // Source-level, because both call sites sit inside modules that need a dozen
  // tables to run. Anchored on CALL syntax, never on the bare symbol: a bare
  // symbol also matches the import line and would pass with the call deleted.
  const read = (p: string) => readFileSync(join(__dirname, "../../../..", p), "utf8");

  it("the daily stale-red scan computes the deadline red AND puts it in the digest", () => {
    const src = read("src/app/api/internal/cpi/stale-red-scan/route.ts");
    expect(src).toMatch(/duplicateFlagReds = await assessAllDuplicateFlagDeadlines\(db, now\)/);
    expect(src).toMatch(/const allReds = \[[^\]]*\.\.\.duplicateFlagReds,/);
  });

  it("the drain tile registers the queue (which also writes the heartbeat's evidence row)", () => {
    const src = read("src/lib/analytics-overview/queue-drain.ts");
    expect(src).toMatch(/\n\s+duplicateFlagsFlow\(db, now\),/);
  });
});
