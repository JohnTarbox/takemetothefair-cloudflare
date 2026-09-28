/**
 * OPE-1203 — parallel `delete_event_day` calls on one event.
 *
 * The tool used to delete, read the surviving days, compute the public range
 * in JS, then write it: three round trips. Three parallel deletes on Harvest
 * Festival of Crafts interleaved there, and one call returned a raw D1 error
 * from its recompute AFTER its own delete had committed — the caller could not
 * tell whether the day was gone, and the range it tried to write came from a
 * row another call had already removed.
 *
 * Now the delete and the recompute are one atomic batch, the range computed in
 * SQL from the rows that survive. These tests pin: the SQL form equals
 * `computePublicDates` (the one implementation it must not drift from), N
 * parallel deletes leave the range consistent with the surviving rows, and a
 * failed batch says plainly that nothing was deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { computePublicDates, recomputePublicDatesStmt } from "../src/helpers.js";
import { events, eventDays, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

type Result = { content: Array<{ text: string }>; isError?: boolean };

function seedEvent(id: string, days: Array<{ date: string; vendorOnly?: boolean }>) {
  db.insert(events)
    .values({ id, name: id, slug: id, promoterId: "p1", status: "APPROVED" } as never)
    .run();
  for (const d of days) {
    db.insert(eventDays)
      .values({
        id: `${id}_${d.date}`,
        eventId: id,
        date: d.date,
        vendorOnly: d.vendorOnly ?? false,
      })
      .run();
  }
}
const publicRange = (id: string) => {
  const r = db.select().from(events).where(eq(events.id, id)).all()[0];
  return {
    start: r.publicStartDate?.toISOString() ?? null,
    end: r.publicEndDate?.toISOString() ?? null,
  };
};
const expectedFromRows = (id: string) => {
  const rows = db
    .select({ date: eventDays.date, vendorOnly: eventDays.vendorOnly })
    .from(eventDays)
    .where(eq(eventDays.eventId, id))
    .all();
  const { publicStartDate, publicEndDate } = computePublicDates(rows);
  return {
    start: publicStartDate?.toISOString() ?? null,
    end: publicEndDate?.toISOString() ?? null,
  };
};
const del = async (dayId: string) =>
  (await server.invoke("delete_event_day", { day_id: dayId })) as Result;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
});
afterEach(() => mock.restore());

describe("the SQL recompute equals computePublicDates", () => {
  const shapes: Array<[string, Array<{ date: string; vendorOnly?: boolean }>]> = [
    ["no days", []],
    ["one day", [{ date: "2026-10-24" }]],
    ["unordered days", [{ date: "2026-11-01" }, { date: "2026-10-24" }, { date: "2026-10-31" }]],
    [
      "vendor-only edges excluded",
      [
        { date: "2026-10-23", vendorOnly: true },
        { date: "2026-10-24" },
        { date: "2026-10-26", vendorOnly: true },
      ],
    ],
    ["only vendor-only days", [{ date: "2026-10-23", vendorOnly: true }]],
    ["year boundary", [{ date: "2026-12-31" }, { date: "2027-01-01" }]],
  ];
  for (const [label, days] of shapes) {
    it(label, async () => {
      seedEvent("e", days);
      await recomputePublicDatesStmt(db as never, "e");
      expect(publicRange("e")).toEqual(expectedFromRows("e"));
    });
  }

  it("anchors at noon UTC, never midnight (the OPE-482/644 defect)", async () => {
    seedEvent("e", [{ date: "2026-10-24" }]);
    await recomputePublicDatesStmt(db as never, "e");
    expect(publicRange("e").start).toBe("2026-10-24T12:00:00.000Z");
  });
});

describe("delete_event_day under concurrency", () => {
  it("N parallel deletes: every call succeeds and the range matches the surviving day", async () => {
    // The Harvest Festival shape: four days, three deleted at once.
    seedEvent("hf", [
      { date: "2026-10-23" },
      { date: "2026-10-24" },
      { date: "2026-10-25" },
      { date: "2026-10-31" },
    ]);
    const results = await Promise.all([
      del("hf_2026-10-23"),
      del("hf_2026-10-24"),
      del("hf_2026-10-25"),
    ]);
    for (const r of results) expect(r.isError).toBeFalsy();
    expect(publicRange("hf")).toEqual({
      start: "2026-10-31T12:00:00.000Z",
      end: "2026-10-31T12:00:00.000Z",
    });
  });

  it("with D1-style latency — earlier calls' writes land LAST — the range still matches the survivors", async () => {
    // better-sqlite3 is synchronous, so without this every call reads the
    // survivors after all deletes and the race cannot occur. Model the prod
    // interleaving: the k-th write of the event range is held back so the
    // calls' writes land in REVERSE order. Under the old read-compute-write
    // code the first caller's stale range (computed from 3 surviving days)
    // lands last; under the SQL recompute each write reads the rows as they
    // are when it runs.
    seedEvent("lat", [
      { date: "2026-10-23" },
      { date: "2026-10-24" },
      { date: "2026-10-25" },
      { date: "2026-10-31" },
    ]);
    // Wrap a query builder's terminal `where(...)` so awaiting it waits first.
    const delayWhere = <T extends { where: (c: never) => unknown }>(
      w: T,
      wait: () => Promise<unknown>
    ) => {
      const realWhere = w.where.bind(w);
      (w as unknown as { where: unknown }).where = (c: never) => {
        const stmt = realWhere(c) as { then: (a: never, b: never) => unknown };
        const realThen = stmt.then.bind(stmt);
        (stmt as unknown as { then: unknown }).then = (ok: never, bad: never) =>
          wait().then(() => realThen(ok, bad));
        return stmt;
      };
      return w;
    };
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    // Deletes land in CALL order, 20ms apart (so call 1 reads survivors before
    // call 2's delete); range writes land in REVERSE call order.
    let d = 0;
    let u = 0;
    const realDelete = db.delete.bind(db);
    (db as unknown as { delete: unknown }).delete = (table: never) => {
      const q = realDelete(table);
      if (table !== eventDays) return q;
      const n = d++;
      return delayWhere(q as never, () => sleep(n * 20));
    };
    const realUpdate = db.update.bind(db);
    (db as unknown as { update: unknown }).update = (table: never) => {
      const q = realUpdate(table);
      if (table !== events) return q;
      const realSet = q.set.bind(q);
      (q as unknown as { set: unknown }).set = (v: never) => {
        const n = u++;
        return delayWhere(realSet(v) as never, () => sleep(60 + (3 - n) * 40));
      };
      return q;
    };
    // The fixed code issues both statements inside one batch (the shim runs
    // them synchronously, so the wrappers above never delay anything there):
    // hold whole batches back in reverse order too, so it faces the same
    // reordering.
    let b = 0;
    const realBatch = (db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch;
    (db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch = async (s) => {
      await sleep((3 - b++) * 40);
      return realBatch(s);
    };
    await Promise.all([del("lat_2026-10-23"), del("lat_2026-10-24"), del("lat_2026-10-25")]);
    expect(publicRange("lat")).toEqual({
      start: "2026-10-31T12:00:00.000Z",
      end: "2026-10-31T12:00:00.000Z",
    });
  });

  it("deleting every day in parallel clears the range to NULL", async () => {
    seedEvent("all", [{ date: "2026-10-24" }, { date: "2026-10-25" }]);
    await recomputePublicDatesStmt(db as never, "all");
    expect(publicRange("all").start).not.toBeNull(); // landmark: it had a range
    await Promise.all([del("all_2026-10-24"), del("all_2026-10-25")]);
    expect(publicRange("all")).toEqual({ start: null, end: null });
  });

  it("a failed batch is a clear error that says the day was NOT deleted, and changes nothing", async () => {
    seedEvent("f", [{ date: "2026-10-24" }, { date: "2026-10-25" }]);
    await recomputePublicDatesStmt(db as never, "f");
    const before = publicRange("f");
    (db as unknown as { batch: () => Promise<never> }).batch = async () => {
      throw new Error("D1_ERROR: simulated");
    };
    const r = await del("f_2026-10-24");
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.deleted).toBe(false);
    expect(body.error).toContain("simulated");
    expect(db.select().from(eventDays).where(eq(eventDays.id, "f_2026-10-24")).all()).toHaveLength(
      1
    );
    expect(publicRange("f")).toEqual(before);
  });
});

describe("the other day writes use the same recompute", () => {
  it("update_event_day moving the last day moves the public end", async () => {
    seedEvent("u", [{ date: "2026-10-24" }, { date: "2026-10-25" }]);
    const r = (await server.invoke("update_event_day", {
      day_id: "u_2026-10-25",
      date: "2026-10-27",
    })) as Result;
    expect(r.isError).toBeFalsy();
    expect(publicRange("u")).toEqual({
      start: "2026-10-24T12:00:00.000Z",
      end: "2026-10-27T12:00:00.000Z",
    });
  });

  it("update_event_day marking the first day vendor-only drops it from the public range", async () => {
    seedEvent("v", [{ date: "2026-10-23" }, { date: "2026-10-24" }]);
    await server.invoke("update_event_day", { day_id: "v_2026-10-23", vendor_only: true });
    expect(publicRange("v").start).toBe("2026-10-24T12:00:00.000Z");
  });

  it("create_event_day in parallel: the range covers every created day", async () => {
    seedEvent("c", []);
    const dates = ["2026-10-24", "2026-10-25", "2026-10-26"];
    const rs = (await Promise.all(
      dates.map((date) =>
        server.invoke("create_event_day", {
          event_id: "c",
          date,
          open_time: "09:00",
          close_time: "17:00",
        })
      )
    )) as Result[];
    for (const r of rs) expect(r.isError).toBeFalsy();
    expect(publicRange("c")).toEqual({
      start: "2026-10-24T12:00:00.000Z",
      end: "2026-10-26T12:00:00.000Z",
    });
  });
});
