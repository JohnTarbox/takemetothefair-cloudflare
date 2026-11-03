/**
 * OPE-767 — WHY an event is flagged (John, 2026-09-30: option A).
 *
 * `events.flagged_for_review` is now the OR of the ACTIVE rows in
 * `event_review_flags`. Each axis raises and clears only its own reason:
 * filling in hours must never discharge an unreviewed rollover.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import {
  events,
  eventReviewFlags,
  promoters,
  raiseEventReviewFlag,
  clearEventReviewFlag,
} from "../src/schema.js";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "k" };

let db: TestDb;
let server: CapturingMcpServer;
const parse = (r: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON tool output
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text) as Record<string, any>;
const call = async (name: string, args: Record<string, unknown>) =>
  parse(await server.invoke(name, args));
const flagged = async () =>
  (await db.select({ f: events.flaggedForReview }).from(events).where(eq(events.id, "e1")))[0].f;
const active = async () =>
  (await db.select().from(eventReviewFlags).where(eq(eventReviewFlags.eventId, "e1")))
    .filter((r) => !r.clearedAt)
    .map((r) => r.reason)
    .sort();

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN, ENV as never);
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "e1", name: "Fair", slug: "fair", promoterId: "p1", status: "APPROVED" })
    .run();
});

describe("raise / clear — each axis owns only its reason", () => {
  it("raising twice keeps ONE active row and sets the flag", async () => {
    await raiseEventReviewFlag(db, "e1", "rollover");
    await raiseEventReviewFlag(db, "e1", "rollover");
    expect(await active()).toEqual(["rollover"]);
    expect(await flagged()).toBe(1);
  });

  it("clearing missing_hours does NOT discharge a rollover — the flag stays up", async () => {
    await raiseEventReviewFlag(db, "e1", "rollover");
    await raiseEventReviewFlag(db, "e1", "missing_hours");
    await clearEventReviewFlag(db, "e1", "missing_hours", "hours-axis");
    expect(await active()).toEqual(["rollover"]);
    expect(await flagged()).toBe(1);
  });

  it("clearing the LAST reason lowers the flag, and the cleared row is kept as audit", async () => {
    await raiseEventReviewFlag(db, "e1", "missing_hours");
    await clearEventReviewFlag(db, "e1", "missing_hours", "hours-axis");
    expect(await flagged()).toBe(0);
    const rows = await db.select().from(eventReviewFlags).where(eq(eventReviewFlags.eventId, "e1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "missing_hours", clearedBy: "hours-axis" });
  });
});

describe("the MCP day tools are the hours axis, both directions", () => {
  async function addDay(open: string | null, close: string | null) {
    return call("create_event_day", {
      event_id: "e1",
      date: "2026-10-10",
      ...(open ? { open_time: open } : {}),
      ...(close ? { close_time: close } : {}),
    });
  }

  it("a day with no hours raises missing_hours; filling it in clears ONLY that", async () => {
    await raiseEventReviewFlag(db, "e1", "rollover");
    const created = await addDay(null, null);
    expect(await active()).toEqual(["missing_hours", "rollover"]);
    const r = await call("update_event_day", {
      day_id: created.id,
      open_time: "09:00",
      close_time: "17:00",
    });
    expect(r.hours_review_reason).toBe("cleared");
    expect(await active()).toEqual(["rollover"]); // the rollover review is NOT discharged
    expect(await flagged()).toBe(1);
  });

  it("blanking a day's hours raises missing_hours (the tool used to do nothing here)", async () => {
    const created = await addDay("09:00", "17:00");
    expect(await flagged()).toBe(0);
    await call("update_event_day", { day_id: created.id, open_time: null });
    expect(await active()).toEqual(["missing_hours"]);
    expect(await flagged()).toBe(1);
  });
});

describe("clear_event_review_flag — the reviewer's audited route", () => {
  it("refuses a reason that is not active, and changes nothing", async () => {
    await raiseEventReviewFlag(db, "e1", "legacy");
    const r = await call("clear_event_review_flag", {
      event_id: "e1",
      reason: "rollover",
      note: "looked",
    });
    expect(r).toMatchObject({ error: "reason_not_active", active_reasons: ["legacy"] });
    expect(await flagged()).toBe(1);
  });

  it("clears a legacy flag after review, lowers the flag, and audits it", async () => {
    await raiseEventReviewFlag(db, "e1", "legacy");
    const r = await call("clear_event_review_flag", {
      event_id: "e1",
      reason: "legacy",
      note: "hours confirmed against the organizer page",
    });
    expect(r).toMatchObject({
      success: true,
      cleared: "legacy",
      flagged_for_review: false,
      active_reasons: [],
    });
    const reasons = await call("get_event_review_flags", { event_id: "e1" });
    expect(reasons.history).toMatchObject([
      {
        reason: "legacy",
        cleared_by: "u-admin",
        note: "hours confirmed against the organizer page",
      },
    ]);
  });
});

describe("drizzle/0341 — the legacy backfill", () => {
  const SQL = readFileSync(
    resolve(__dirname, "../../drizzle/0341_ope767_event_review_flags.sql"),
    "utf8"
  );
  const fresh = () => {
    const raw = new Database(":memory:");
    raw.exec(
      "CREATE TABLE events (id TEXT PRIMARY KEY, flagged_for_review INTEGER NOT NULL DEFAULT 0);"
    );
    return raw;
  };

  it("gives every flagged row exactly one 'legacy' reason, and is idempotent", () => {
    const raw = fresh();
    raw.exec("INSERT INTO events VALUES ('a', 1), ('b', 0), ('c', 1);");
    raw.exec(SQL);
    raw.exec(SQL); // re-run: no duplicates
    const rows = raw
      .prepare("SELECT event_id, reason FROM event_review_flags ORDER BY event_id")
      .all();
    expect(rows).toEqual([
      { event_id: "a", reason: "legacy" },
      { event_id: "c", reason: "legacy" },
    ]);
  });

  it("is a no-op on an empty database (CI builds one from migrations)", () => {
    const raw = fresh();
    expect(() => raw.exec(SQL)).not.toThrow();
    expect(raw.prepare("SELECT count(*) n FROM event_review_flags").get()).toEqual({ n: 0 });
  });
});

/**
 * Structural guard, keyed on the ACT. A flag raised without a reason row is
 * silently lowered by the next axis that clears — the failure this table
 * exists to prevent. So no write to `events` may set flaggedForReview itself.
 */
describe("structural guard — every events flag goes through raiseEventReviewFlag", () => {
  const ROOTS = [resolve(__dirname, "../src"), resolve(__dirname, "../../src")];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (n === "node_modules" || n === "__tests__") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p);
    }
  };
  ROOTS.forEach(walk);

  const blocks: Array<{ file: string; text: string }> = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.(insert|update)\(events\)/g)) {
      // The statement runs to its terminating `;` — enough to hold the .values()/.set() object.
      const end = src.indexOf(";", m.index!);
      blocks.push({ file: f, text: src.slice(m.index!, end === -1 ? m.index! + 4000 : end) });
    }
  }

  it("finds the events writers (positive landmark)", () => {
    expect(blocks.length).toBeGreaterThan(30);
  });

  it("no insert(events)/update(events) writes flaggedForReview directly", () => {
    const offenders = blocks
      .filter((b) => /flaggedForReview\s*:/.test(b.text))
      .map((b) => b.file.replace(/^.*takemetothefair-cloudflare\//, ""));
    expect(offenders).toEqual([]);
  });

  it("no code assigns flaggedForReview on an events update object", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/\b(updates|updateData)\.flaggedForReview\s*=/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
