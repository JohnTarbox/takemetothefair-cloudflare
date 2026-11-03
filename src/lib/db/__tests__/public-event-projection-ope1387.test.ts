/**
 * OPE-1387 — the public event projection is an ALLOW-LIST.
 *
 * `eventJoinProjection` / `eventVenueJoinProjection` used to select
 * `events: events` (every column) and `promoters.userId`. Their rows are
 * spread into "use client" components and public JSON, so `suggester_email`,
 * `submitted_by_user_id`, operator notes and dedup pointers reached public
 * page source. These tests pin the shape so a private column cannot ride back.
 */
import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import {
  eventJoinProjection,
  eventVenueJoinProjection,
  publicEventColumns,
  PUBLIC_EVENT_KEYS,
  toPublicEvent,
  type PublicEvent,
} from "@/lib/db/event-join-projection";

/** Columns that must never be public — named explicitly so a loosening of the
 *  generic pattern below cannot quietly let one through. */
const NAMED_PRIVATE = [
  "suggesterEmail",
  "submittedByUserId",
  "userId",
  "lifecycleCheckNote",
  "lifecycleLastCheckedAt",
  "gateFlags",
  "flaggedForReview",
  "mergedInto",
  "possibleDuplicateOf",
  "rejectedAsDuplicateOf",
  "rolledFromEventId",
  "internalNotes",
  "approvalNotifiedAt",
  "syncEnabled",
  "sourceId",
  "ingestionMethod",
] as const;

/** Generic private-shaped names. There is no exception list: no allow-listed
 *  key matches today. (`accessNotes` / `vendorFeeNotes` are PUBLIC visitor
 *  copy — OPE-1151 — and deliberately not matched: the pattern targets
 *  email / internal / token / secret / password / user-id.) */
const PRIVATE_PATTERN = /email|internal|token|secret|password|user_?id/i;

describe("OPE-1387 — public event projection", () => {
  it("the allow-list excludes every named private column", () => {
    for (const k of NAMED_PRIVATE) {
      expect(PUBLIC_EVENT_KEYS as readonly string[]).not.toContain(k);
    }
  });

  it("no allow-listed key or SQL column name looks private", () => {
    const sqlNames = Object.values(publicEventColumns).map((c) => c.name);
    const offenders = [...PUBLIC_EVENT_KEYS, ...sqlNames].filter((n) => PRIVATE_PATTERN.test(n));
    expect(offenders).toEqual([]);
  });

  it("is a strict subset of the events table, column for column", () => {
    const cols = getTableColumns(events) as Record<string, unknown>;
    for (const [k, v] of Object.entries(publicEventColumns)) expect(v).toBe(cols[k]);
    expect(PUBLIC_EVENT_KEYS.length).toBeLessThan(Object.keys(cols).length);
  });

  it("both join projections use the allow-list, never the whole table", () => {
    expect(eventJoinProjection.events).toBe(publicEventColumns);
    expect(eventVenueJoinProjection.events).toBe(publicEventColumns);
  });

  it("the joined venue/promoter blocks carry no account ids or contact fields", () => {
    const joined = [
      ...Object.keys(eventJoinProjection.venue),
      ...Object.keys(eventJoinProjection.promoter),
      ...Object.keys(eventVenueJoinProjection.venue),
    ];
    expect(joined).not.toContain("userId");
    expect(joined.filter((k) => /email|phone|user_?id|token|internal|note/i.test(k))).toEqual([]);
  });

  it("toPublicEvent strips columns outside the allow-list at runtime", () => {
    const full = {
      ...Object.fromEntries(PUBLIC_EVENT_KEYS.map((k) => [k, null])),
      id: "e1",
      suggesterEmail: "SENTINEL-NOT-AN-ADDRESS",
      submittedByUserId: "u1",
      lifecycleCheckNote: "private",
      gateFlags: "[]",
    } as unknown as PublicEvent;
    const out = toPublicEvent(full) as Record<string, unknown>;
    expect(out.id).toBe("e1");
    expect(Object.keys(out).sort()).toEqual([...PUBLIC_EVENT_KEYS].sort());
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
    expect(out).not.toHaveProperty("submittedByUserId");
  });
});
