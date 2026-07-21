/**
 * OPE-225 follow-up — the scan must never report a PARTIAL run as a good one.
 *
 * What actually happened on the first production run (2026-07-21 06:01Z): the
 * write phase issued ~6,400 sequential `await db.insert()` calls and the
 * isolate was killed mid-loop. EVENT (1,405) and part of VENDOR (5,028) landed;
 * VENUE, PROMOTER and PERFORMER were never written at all. Nothing was logged,
 * because the request died rather than threw.
 *
 * The damage was not the crash — it was that the leftover table reported 46%
 * event coverage and rendered the three missing types as 0/0, which reads as
 * "measured and empty". These tests pin the two properties that make that
 * impossible: writes go out in batches, and `complete` tells the truth.
 */
import { describe, it, expect, vi } from "vitest";
import { refreshImageCoverageState } from "../scan";

/**
 * Minimal drizzle stand-in.
 *
 * `select().from()` is awaited directly for the prior-state read and resolves
 * `[]`; with `.where()` it also resolves `[]`. `batch()` records how many
 * statements it received, and can be made to die partway to simulate the kill.
 */
function fakeDb(entitiesByCall: unknown[][], opts: { dieAfterBatches?: number } = {}) {
  let selectCall = 0;
  const batches: number[] = [];

  /**
   * A chain that answers `.from().where().groupBy()` in any combination and is
   * awaitable at every step — the scan awaits `select().from()` directly for
   * entities, but `select().from().where().groupBy()` for GSC demand.
   */
  const chain = (rows: unknown[]): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      from: () => self,
      where: () => self,
      groupBy: () => self,
      orderBy: () => self,
      limit: () => self,
      then: (res: (v: unknown[]) => unknown) => res(rows),
    };
    return self;
  };

  const db = {
    select: () => chain(entitiesByCall[selectCall++] ?? []),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => ({ __stmt: true }) }),
    }),
    batch: vi.fn(async (stmts: unknown[]) => {
      if (opts.dieAfterBatches != null && batches.length >= opts.dieAfterBatches) {
        throw new Error("Worker exceeded resource limits");
      }
      batches.push(stmts.length);
      return [];
    }),
  };
  return { db: db as never, batches };
}

/** `loadEntities` issues 5 selects in order: events, venues, promoters, vendors, performers. */
function entitySets(counts: { ev: number; ve: number; pr: number; vn: number; pf: number }) {
  const rows = (n: number, prefix: string, extra: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}${i}`,
      slug: `${prefix}-slug-${i}`,
      imageUrl: null,
      ...extra,
    }));
  return [
    rows(counts.ev, "ev"),
    rows(counts.ve, "ve"),
    rows(counts.pr, "pr", { heroImageUrl: null, logoUrl: null }),
    rows(counts.vn, "vn"),
    rows(counts.pf, "pf"),
    [], // gsc demand rows
    [], // prior image_coverage_state rows
  ];
}

describe("refreshImageCoverageState — write batching + completeness", () => {
  it("batches writes instead of one round trip per row", async () => {
    // 250 entities must not become 250 sequential statements — that shape is
    // what got the first run killed.
    const { db, batches } = fakeDb(entitySets({ ev: 100, ve: 50, pr: 40, vn: 40, pf: 20 }));
    const out = await refreshImageCoverageState(db, new Date("2026-07-21T06:00:00Z"));

    expect(out.scanned).toBe(250);
    expect(batches.length).toBeLessThanOrEqual(3); // 250 / 100
    expect(batches.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it("reports complete + per-type counts when every type is written", async () => {
    const { db } = fakeDb(entitySets({ ev: 3, ve: 2, pr: 2, vn: 2, pf: 1 }));
    const out = await refreshImageCoverageState(db, new Date("2026-07-21T06:00:00Z"));

    expect(out.complete).toBe(true);
    expect(out.writtenByType).toEqual({
      EVENT: 3,
      VENDOR: 2,
      VENUE: 2,
      PROMOTER: 2,
      PERFORMER: 1,
    });
  });

  it("a mid-write death propagates — it does NOT return a rosy partial result", async () => {
    // The exact 2026-07-21 shape: some types land, the rest never do.
    const { db } = fakeDb(entitySets({ ev: 150, ve: 50, pr: 50, vn: 50, pf: 50 }), {
      dieAfterBatches: 1,
    });

    // Must reject. Silently resolving with complete:false would still be better
    // than before, but a throw is what the route turns into a 500.
    await expect(refreshImageCoverageState(db, new Date("2026-07-21T06:00:00Z"))).rejects.toThrow(
      /resource limits/
    );
  });

  it("counts every loaded entity type, so a missing type can be detected", async () => {
    const { db } = fakeDb(entitySets({ ev: 1, ve: 1, pr: 1, vn: 1, pf: 1 }));
    const out = await refreshImageCoverageState(db, new Date("2026-07-21T06:00:00Z"));
    expect(Object.keys(out.writtenByType).sort()).toEqual([
      "EVENT",
      "PERFORMER",
      "PROMOTER",
      "VENDOR",
      "VENUE",
    ]);
  });
});
