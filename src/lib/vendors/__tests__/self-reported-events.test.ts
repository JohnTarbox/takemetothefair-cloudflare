/**
 * OPE-239 — vendor self-attested participation.
 *
 * The invariant under test is a NEGATIVE one: this feature must never touch
 * `event_vendors`. A test that only checks the happy path would pass just as
 * happily on an implementation that quietly promoted assertions into the
 * organizer-confirmed roster — which is the single thing the ticket forbids.
 */
import { describe, it, expect } from "vitest";
import { setSelfReportedEvents, MAX_SELF_REPORTED_PER_VENDOR } from "../self-reported-events";
import { eventVendors, vendorSelfReportedEvents } from "@/lib/db/schema";

/**
 * Minimal chainable Drizzle stub.
 *
 * `selectResults` is a queue: the module issues (1) the valid-event lookup then
 * (2) the existing-rows lookup, in that order.
 */
function makeDb(selectResults: unknown[][]) {
  const queue = [...selectResults];
  const inserted: unknown[] = [];
  const deleted: unknown[] = [];
  const insertTables: unknown[] = [];

  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.innerJoin = step;
    chain.leftJoin = step;
    chain.orderBy = step;
    chain.limit = step;
    chain.where = () => Promise.resolve(queue.shift() ?? []);
    return chain;
  };

  const db = {
    select: () => selectChain(),
    insert: (table: unknown) => {
      insertTables.push(table);
      return {
        values: (v: unknown) => {
          inserted.push(v);
          return { onConflictDoNothing: () => Promise.resolve(null) };
        },
      };
    },
    delete: () => ({
      where: (w: unknown) => {
        deleted.push(w);
        return Promise.resolve(null);
      },
    }),
  };
  return { db, inserted, deleted, insertTables };
}

describe("setSelfReportedEvents (OPE-239)", () => {
  it("adds only the ids that are real events and not already present", async () => {
    const { db, inserted } = makeDb([
      [{ id: "e1" }, { id: "e2" }], // valid lookup
      [{ eventId: "e1" }], // already asserted
    ]);
    const delta = await setSelfReportedEvents(db as never, {
      vendorId: "v1",
      eventIds: ["e1", "e2"],
    });
    expect(delta.added).toEqual(["e2"]);
    expect(delta.removed).toEqual([]);
    const rows = inserted[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("e2");
    expect(rows[0].status).toBe("SELF_REPORTED");
  });

  it("removes assertions the vendor deselected — set semantics, not append-only", async () => {
    const { db, deleted } = makeDb([[{ id: "e1" }], [{ eventId: "e1" }, { eventId: "e9" }]]);
    const delta = await setSelfReportedEvents(db as never, {
      vendorId: "v1",
      eventIds: ["e1"],
    });
    expect(delta.removed).toEqual(["e9"]);
    expect(deleted).toHaveLength(1);
  });

  it("is idempotent — resubmitting the same set writes nothing", async () => {
    const { db, inserted, deleted } = makeDb([[{ id: "e1" }], [{ eventId: "e1" }]]);
    const delta = await setSelfReportedEvents(db as never, {
      vendorId: "v1",
      eventIds: ["e1"],
    });
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(inserted).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it("silently drops ids that are not real events rather than failing the save", async () => {
    // A stale id in the client's cache must not take down an honest save.
    const { db, inserted } = makeDb([[{ id: "e1" }], []]);
    const delta = await setSelfReportedEvents(db as never, {
      vendorId: "v1",
      eventIds: ["e1", "does-not-exist"],
    });
    expect(delta.added).toEqual(["e1"]);
    const rows = inserted[0] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.eventId)).not.toContain("does-not-exist");
  });

  it("de-duplicates a repeated id in the request", async () => {
    const { db } = makeDb([[{ id: "e1" }], []]);
    const delta = await setSelfReportedEvents(db as never, {
      vendorId: "v1",
      eventIds: ["e1", "e1", "e1"],
    });
    expect(delta.added).toEqual(["e1"]);
  });

  it("caps the set so one vendor cannot assert unbounded participation", async () => {
    const many = Array.from({ length: MAX_SELF_REPORTED_PER_VENDOR + 25 }, (_, i) => `e${i}`);
    const capped = many.slice(0, MAX_SELF_REPORTED_PER_VENDOR).map((id) => ({ id }));
    const { db } = makeDb([capped, []]);
    const delta = await setSelfReportedEvents(db as never, { vendorId: "v1", eventIds: many });
    expect(delta.added).toHaveLength(MAX_SELF_REPORTED_PER_VENDOR);
  });

  it("writes ONLY to vendor_self_reported_events — never to event_vendors", async () => {
    // THE load-bearing test. Self-attestation must not become an
    // organizer-confirmed roster row, in any code path, ever.
    const { db, insertTables } = makeDb([[{ id: "e1" }], []]);
    await setSelfReportedEvents(db as never, { vendorId: "v1", eventIds: ["e1"] });

    // Identity comparison against the real table objects — stronger than a
    // string match, and immune to Drizzle's circular table structure.
    expect(insertTables).toHaveLength(1);
    expect(insertTables[0]).toBe(vendorSelfReportedEvents);
    expect(insertTables).not.toContain(eventVendors);
  });

  it("records the source context so claim-time and profile-time are distinguishable", async () => {
    const { db, inserted } = makeDb([[{ id: "e1" }], []]);
    await setSelfReportedEvents(db as never, {
      vendorId: "v1",
      eventIds: ["e1"],
      sourceContext: "claim",
    });
    const rows = inserted[0] as Array<Record<string, unknown>>;
    expect(rows[0].sourceContext).toBe("claim");
  });

  it("handles an empty selection without querying for valid ids", async () => {
    const { db, inserted, deleted } = makeDb([[{ eventId: "e1" }]]);
    const delta = await setSelfReportedEvents(db as never, { vendorId: "v1", eventIds: [] });
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual(["e1"]);
    expect(inserted).toHaveLength(0);
    expect(deleted).toHaveLength(1);
  });
});
