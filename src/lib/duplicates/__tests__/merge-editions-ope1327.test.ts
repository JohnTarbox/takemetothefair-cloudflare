/**
 * OPE-1327 — the merge guard refuses two DIFFERENT editions of one year on a
 * multi-edition series, at the route (409 different_editions) AND in the core
 * (executeMerge throws), with the existing allowCrossYearMerge override intact.
 * Annual pairs (NULL keys) behave exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { differentEditions } from "@/lib/series/merge-year-guard";

const { repointPromoterChildren, repointVenueChildren } = vi.hoisted(() => ({
  repointPromoterChildren: vi.fn(async () => ({})),
  repointVenueChildren: vi.fn(async () => ({})),
}));
vi.mock("@takemetothefair/db-schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@takemetothefair/db-schema")>()),
  repointPromoterChildren,
  repointVenueChildren,
}));

import { executeMerge } from "../merge-operations";

const may = new Date("2027-05-15T12:00:00Z");
const oct = new Date("2027-10-01T12:00:00Z");

describe("differentEditions (pure)", () => {
  it("two keyed members of one year with DIFFERENT keys are different editions", () => {
    expect(
      differentEditions(
        { startDate: may, editionKey: "2027-05" },
        { startDate: oct, editionKey: "2027-10" }
      )
    ).toBe(true);
  });
  it("the same key is the same edition (a real duplicate may merge)", () => {
    expect(
      differentEditions(
        { startDate: may, editionKey: "2027-05" },
        { startDate: may, editionKey: "2027-05" }
      )
    ).toBe(false);
  });
  it("NULL keys (every annual row) never trigger the key branch — annual unchanged", () => {
    expect(
      differentEditions({ startDate: may, editionKey: null }, { startDate: oct, editionKey: null })
    ).toBe(false);
    expect(
      differentEditions(
        { startDate: may, editionKey: "2027-05" },
        { startDate: oct, editionKey: null }
      )
    ).toBe(false);
  });
  it("different years still refuse, keys or not (OPE-481 unchanged)", () => {
    expect(
      differentEditions({ startDate: may }, { startDate: new Date("2028-05-15T12:00:00Z") })
    ).toBe(true);
  });
});

describe("executeMerge — core refuses two editions of one year", () => {
  function dbWith(keeperKey: string | null, dupKey: string | null) {
    const snap = (id: string, startDate: Date, editionKey: string | null, extra = {}) => ({
      slug: `${id}-slug`,
      viewCount: 0,
      sourceUrl: null,
      sourceDomain: null,
      sourceId: null,
      sourceName: null,
      startDate,
      editionKey,
      ...extra,
    });
    return {
      batch: vi
        .fn()
        .mockResolvedValue([
          [],
          [snap("keeper", may, keeperKey)],
          [snap("dup", oct, dupKey, { mergedInto: null })],
        ]),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue([]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
    };
  }

  it("REFUSES May into October (different keys), before any write, naming both keys", async () => {
    const db = dbWith("2027-05", "2027-10");
    await expect(executeMerge(db as never, "events", "keeper-id", "dup-id")).rejects.toThrow(
      /two different editions .*2027-05.*2027-10/s
    );
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("allowCrossYearMerge still overrides it deliberately", async () => {
    const db = dbWith("2027-05", "2027-10");
    const err = await executeMerge(db as never, "events", "keeper-id", "dup-id", null, {
      allowCrossYearMerge: true,
    }).catch((e: Error) => e);
    expect(String(err)).not.toMatch(/different editions/);
  });

  it("an annual same-year pair (NULL keys) is NOT refused — unchanged", async () => {
    const db = dbWith(null, null);
    const err = await executeMerge(db as never, "events", "keeper-id", "dup-id").catch(
      (e: Error) => e
    );
    expect(String(err)).not.toMatch(/different editions|cross-year/);
  });
});

// ── the route: 409 before executeMerge is ever called ─────────────────────────
const executeMergeSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
describe("POST /api/admin/duplicates/merge — 409 different_editions", () => {
  let raw: Database.Database;

  beforeEach(async () => {
    vi.resetModules();
    const { createTestDb } = await import("../../../../mcp-server/__tests__/setup-db");
    const t = createTestDb();
    raw = t.raw;
    raw
      .prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'NEAR', 'near')`)
      .run();
    const ins = raw.prepare(
      `INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, edition_key)
       VALUES (?, ?, ?, 'p1', ?, ?, 'APPROVED', ?)`
    );
    const s = (d: Date) => Math.floor(d.getTime() / 1000);
    ins.run("e-may", "NEAR-Fest XLI", "near-fest-xli", s(may), s(may), "2027-05");
    ins.run("e-oct", "NEAR-Fest XLII", "near-fest-xlii", s(oct), s(oct), "2027-10");
    ins.run("e-a1", "Fair", "fair-a", s(may), s(may), null);
    ins.run("e-a2", "Fair", "fair-b", s(oct), s(oct), null);
    vi.doMock("@/lib/api/with-auth", () => ({
      withAuthorized:
        (h: (ctx: { request: Request; db: unknown; userId: string }) => Promise<Response>) =>
        (request: Request) =>
          h({ request, db: t.db, userId: "admin" }),
    }));
    vi.doMock("@/lib/duplicates/merge-operations", () => ({ executeMerge: executeMergeSpy }));
    executeMergeSpy.mockClear();
  });
  afterEach(() => raw.close());

  const post = async (primaryId: string, duplicateId: string) => {
    const { POST } = await import("@/app/api/admin/duplicates/merge/route");
    return (POST as unknown as (r: Request) => Promise<Response>)(
      new Request("https://x/api/admin/duplicates/merge", {
        method: "POST",
        body: JSON.stringify({ type: "events", primaryId, duplicateId }),
      })
    );
  };

  it("refuses May into October with 409 and both keys, and never calls executeMerge", async () => {
    const res = await post("e-may", "e-oct");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "different_editions",
      keeper_edition: "2027-05",
      duplicate_edition: "2027-10",
    });
    expect(executeMergeSpy).not.toHaveBeenCalled();
  });

  it("lets an annual same-year pair through to executeMerge (unchanged)", async () => {
    const res = await post("e-a1", "e-a2");
    expect(res.status).toBe(200);
    expect(executeMergeSpy).toHaveBeenCalledTimes(1);
  });
});
