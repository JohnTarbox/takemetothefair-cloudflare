import { describe, it, expect } from "vitest";
import { unsafeSlug } from "@/lib/utils";
import {
  insertEventDaysBatched,
  resolveUniqueEventSlug,
  EVENT_DAYS_BATCH_SIZE,
} from "../insert-helpers";

type Row = Record<string, unknown>;

/** Minimal drizzle-shaped mock that records each `.insert().values(rows)` batch. */
function mockInsertDb() {
  const batches: Row[][] = [];
  const db = {
    insert: () => ({
      values: (rows: Row[]) => {
        batches.push(rows);
        return Promise.resolve();
      },
    }),
  };
  return { db, batches };
}

/** Minimal drizzle-shaped mock whose select() resolves to the given slugs. */
function mockSelectDb(existingSlugs: string[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(existingSlugs.map((s) => ({ slug: s }))),
      }),
    }),
  };
}

const day = (date: string, extra: Partial<Row> = {}): Row => ({
  date,
  openTime: "09:00",
  closeTime: "17:00",
  ...extra,
});

describe("insertEventDaysBatched", () => {
  it("no-ops on empty / null / undefined", async () => {
    for (const input of [[], null, undefined]) {
      const { db, batches } = mockInsertDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await insertEventDaysBatched(db as any, "evt", input as any);
      expect(batches).toHaveLength(0);
    }
  });

  it("inserts a single batch when under the limit", async () => {
    const { db, batches } = mockInsertDb();
    const days = Array.from({ length: 5 }, (_, i) => day(`2026-07-0${i + 1}`));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await insertEventDaysBatched(db as any, "evt", days as any);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
  });

  it("chunks at the batch size — the ≥12-day bug fix", async () => {
    // 25 days → 11 + 11 + 3 across 3 statements (was a single statement that
    // blew D1's bound-parameter limit on the promoter paths).
    const { db, batches } = mockInsertDb();
    const days = Array.from({ length: 25 }, (_, i) => day(`2026-07-${i + 1}`));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await insertEventDaysBatched(db as any, "evt", days as any);
    expect(batches.map((b) => b.length)).toEqual([11, 11, 3]);
    expect(EVENT_DAYS_BATCH_SIZE).toBe(11);
  });

  it("exactly one batch at the boundary (11), two at 12", async () => {
    for (const [count, expected] of [
      [11, [11]],
      [12, [11, 1]],
    ] as const) {
      const { db, batches } = mockInsertDb();
      const days = Array.from({ length: count }, (_, i) => day(`d${i}`));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await insertEventDaysBatched(db as any, "evt", days as any);
      expect(batches.map((b) => b.length)).toEqual(expected);
    }
  });

  it("maps fields with the legacy falsy semantics (notes/closed/vendorOnly)", async () => {
    const { db, batches } = mockInsertDb();
    const days = [
      day("2026-07-01", { notes: "", closed: undefined, vendorOnly: true }),
      day("2026-07-02", { openTime: undefined, closeTime: null, notes: "hi", closed: true }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await insertEventDaysBatched(db as any, "evt-99", days as any);
    const [r0, r1] = batches[0];
    expect(r0).toMatchObject({ eventId: "evt-99", notes: null, closed: false, vendorOnly: true });
    expect(typeof r0.id).toBe("string");
    expect(r1).toMatchObject({ openTime: null, closeTime: null, notes: "hi", closed: true });
  });
});

describe("resolveUniqueEventSlug", () => {
  it("returns the base slug when free", async () => {
    const db = mockSelectDb([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slug = await resolveUniqueEventSlug(db as any, unsafeSlug("acton-fair"));
    expect(slug).toBe("acton-fair");
  });

  it("appends -2 on first collision (findUniqueSlug skips -1)", async () => {
    const db = mockSelectDb(["acton-fair"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slug = await resolveUniqueEventSlug(db as any, unsafeSlug("acton-fair"));
    expect(slug).toBe("acton-fair-2");
  });

  it("skips taken suffixes to the next free one", async () => {
    const db = mockSelectDb(["acton-fair", "acton-fair-2", "acton-fair-3"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slug = await resolveUniqueEventSlug(db as any, unsafeSlug("acton-fair"));
    expect(slug).toBe("acton-fair-4");
  });
});
