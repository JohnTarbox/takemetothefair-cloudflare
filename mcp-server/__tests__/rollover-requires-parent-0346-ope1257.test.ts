/**
 * OPE-1257 — drizzle/0346: a rollover-method insert with no parent is refused
 * on every write path. The in-repo writer passes through it (read-back on the
 * created row); the June-15 bulk-INSERT shape is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { rolloverEventIfRecurring } from "../src/event-rollover.js";
import { events, promoters } from "../src/schema.js";

const SQL = readFileSync(
  join(__dirname, "../../drizzle/0346_ope1257_rollover_requires_parent.sql"),
  "utf8"
);

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw.exec(SQL);
  mock = mockIndexNowFetch();
  db.insert(promoters)
    .values({ id: "p1", companyName: "P", slug: unsafeSlug("p") })
    .run();
  db.insert(events)
    .values({
      id: "evt-2026",
      name: "Fryeburg Fair 2026",
      slug: unsafeSlug("fryeburg-fair-2026"),
      promoterId: "p1",
      startDate: new Date(Date.UTC(2026, 9, 4, 12)),
      endDate: new Date(Date.UTC(2026, 9, 13, 12)),
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
      status: "APPROVED",
      lifecycleStatus: "OCCURRED",
    } as never)
    .run();
});
afterEach(() => mock.restore());

const insertRollover = (method: string, parent: string | null) =>
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, status, ingestion_method, rolled_from_event_id)
       VALUES (?, 'Fair 2027', ?, 'p1', 'TENTATIVE', ?, ?)`
    )
    .run(
      `r-${method}-${parent ?? "none"}`,
      `fair-2027-${method}-${parent ?? "none"}`,
      method,
      parent
    );

describe("drizzle/0346 (OPE-1257)", () => {
  it.each(["annual_rollover", "auto_rollover", "manual_rollover"])(
    "refuses a %s row with no rolled_from_event_id (the 06-15 bulk-insert shape)",
    (method) => {
      expect(() => insertRollover(method, null)).toThrow(/ROLLOVER_WITHOUT_PARENT/);
    }
  );

  it("accepts a rollover row that names its parent, and any non-rollover row", () => {
    expect(() => insertRollover("annual_rollover", "evt-2026")).not.toThrow();
    expect(() => insertRollover("email_submission", null)).not.toThrow();
  });

  it("the in-repo writer passes through the trigger; read-back shows the link", async () => {
    const res = await rolloverEventIfRecurring(db, "evt-2026", {
      via: "cron",
      actorUserId: null,
      now: new Date("2026-11-01T00:00:00Z"),
    });
    expect(res.created).toBe(true);
    const [rolled] = db.select().from(events).where(eq(events.id, res.newEventId!)).all();
    expect(rolled.ingestionMethod).toBe("auto_rollover");
    expect(rolled.rolledFromEventId).toBe("evt-2026");
  });

  it("applies cleanly to an empty database and leaves existing NULL-link rows alone", () => {
    expect(() => createTestDb().raw.exec(SQL)).not.toThrow();
    // A legacy unlinkable row (one of the 19) written BEFORE the trigger exists.
    const { db: legacyDb, raw: legacy } = createTestDb();
    legacyDb
      .insert(promoters)
      .values({ id: "p1", companyName: "P", slug: unsafeSlug("p") })
      .run();
    legacy
      .prepare(
        `INSERT INTO events (id, name, slug, promoter_id, status, ingestion_method)
         VALUES ('legacy', 'Old Fair 2027', 'old-fair-2027', 'p1', 'TENTATIVE', 'annual_rollover')`
      )
      .run();
    expect(() => legacy.exec(SQL)).not.toThrow();
    expect(
      legacy.prepare("SELECT rolled_from_event_id r FROM events WHERE id='legacy'").get()
    ).toEqual({
      r: null,
    });
  });
});
