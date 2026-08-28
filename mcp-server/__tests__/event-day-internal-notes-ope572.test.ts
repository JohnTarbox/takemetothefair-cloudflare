/**
 * OPE-572 — `event_days.notes` renders verbatim to the public, and was the only
 * writable text field on the row.
 *
 * Confirmed in the render code rather than inferred (the ticket flagged its own
 * mechanism as unverified): `DailyScheduleDisplay.tsx:293,298` and
 * `EventDayImageStrip.tsx:107` print `day.notes` inline in the Dates block. And
 * `event_days` had no operator column — id, event_id, date, open_time,
 * close_time, notes, closed, vendor_only, image_url, image_focal_x/y,
 * created_at is the complete list.
 *
 * So an analyst grounding a day's hours on an organizer page did the right
 * thing — recorded provenance — into the only field available, and 44 rows put
 * `Source: …` audit prose on live event pages.
 *
 * These tests pin the two halves of the write-side fix: the new column exists
 * and is separate from `notes`, and the tools decode entities on the way in so
 * the `&amp;` class cannot re-enter through the surface that produced it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema.js";
import { eventDays } from "../src/schema.js";
import { decodeHtmlEntities } from "../src/helpers.js";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** DDL generated from the schema — see the note in occurrence-payload-ope581. */
function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(eventDays));
  db = drizzle(raw, { schema });
});

describe("the private column exists and is genuinely separate", () => {
  it("event_days has an internal_notes column", () => {
    const names = getTableConfig(eventDays).columns.map((c) => c.name);
    expect(names).toContain("internal_notes");
  });

  it("writing provenance to internal_notes leaves the public note untouched", async () => {
    // The shape the 44 rows should have had: visitor text in `notes`,
    // attribution in `internal_notes`.
    await db.insert(eventDays).values({
      id: "d1",
      eventId: "e1",
      date: "2026-08-27",
      notes: "Opening day",
      internalNotes: "Hours per cummingtonfair.com/admission-hours, fetched 2026-08-26.",
    });
    const [row] = await db.select().from(eventDays).where(eq(eventDays.id, "d1"));
    expect(row.notes).toBe("Opening day");
    expect(row.notes).not.toMatch(/Source:|http|fetched/);
    expect(row.internalNotes).toContain("cummingtonfair.com");
  });

  it("internal_notes is optional — the ~1,329 correct rows need no change", async () => {
    await db.insert(eventDays).values({
      id: "d2",
      eventId: "e1",
      date: "2026-08-28",
      notes: "Veterans free today with ID",
    });
    const [row] = await db.select().from(eventDays).where(eq(eventDays.id, "d2"));
    expect(row.internalNotes).toBeNull();
    expect(row.notes).toBe("Veterans free today with ID");
  });
});

describe("the entity class cannot re-enter through the tools", () => {
  // The 12 escaped rows are real prose with a literal `&amp;` — "Beer &amp;
  // wine garden", "4-H &amp; Agricultural Awareness Day". Migration 0241 fixes
  // the stored rows; this is the write side, so they do not come back.
  it("decodes the exact strings found in prod", () => {
    for (const [stored, expected] of [
      ["Lumber Jack &amp; Jill competitions", "Lumber Jack & Jill competitions"],
      ["Beer &amp; wine garden 5pm–10pm", "Beer & wine garden 5pm–10pm"],
      ["4-H &amp; Agricultural Awareness Day", "4-H & Agricultural Awareness Day"],
      ["Bret Michaels &amp; Night Ranger", "Bret Michaels & Night Ranger"],
    ] as const) {
      expect(decodeHtmlEntities(stored)).toBe(expected);
    }
  });

  it("is idempotent — a clean note survives the transform unchanged", () => {
    // Runs on every write, not just dirty ones, so this matters more than the
    // escaped case: a regression here would corrupt the 1,329 good rows.
    for (const clean of ["Beer & wine garden", "Opening day", "Veterans free today with ID"]) {
      expect(decodeHtmlEntities(clean)).toBe(clean);
    }
  });
});
