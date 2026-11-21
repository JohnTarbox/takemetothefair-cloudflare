import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { events, vendors } from "./index";
import {
  FIELD_HISTORY_ROWS_PER_INSERT,
  buildFieldHistoryRows,
  fieldHistoryBeforeSelect,
  fieldHistoryInserts,
  normalizeFieldValue,
  systemActor,
} from "./field-history";

const base = {
  entityType: "event" as const,
  entityId: "e1",
  actor: "u1",
  source: "test",
  requestId: "r1",
  at: new Date("2026-11-16T00:00:00Z"),
};

describe("buildFieldHistoryRows (OPE-1651)", () => {
  it("one row per CHANGED field, keyed by the DB column name", () => {
    const rows = buildFieldHistoryRows({
      ...base,
      table: events,
      before: { description: "a", ticketUrl: "https://x", name: "N" },
      patch: { description: "b", ticketUrl: "https://x", name: "N" },
    });
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([["description", "a", "b"]]);
    expect(rows[0]).toMatchObject({ actor: "u1", source: "test", requestId: "r1" });
  });

  it("maps camelCase keys to snake_case columns", () => {
    const [row] = buildFieldHistoryRows({
      ...base,
      table: events,
      before: { imageUrl: null },
      patch: { imageUrl: "https://cdn/x.jpg" },
    });
    expect(row.field).toBe("image_url");
    expect(row.oldValue).toBeNull();
  });

  it("skips updatedAt, raw SQL expressions, undefined values and non-columns", () => {
    const rows = buildFieldHistoryRows({
      ...base,
      table: events,
      before: { viewCount: 3 },
      patch: {
        updatedAt: new Date(),
        viewCount: sql`view_count + 1`,
        description: undefined,
        notAColumn: "x",
      },
    });
    expect(rows).toEqual([]);
  });

  it("a boolean column written as 0/1 compares equal to the stored boolean", () => {
    const rows = buildFieldHistoryRows({
      ...base,
      table: vendors,
      entityType: "vendor",
      before: { verified: true, claimed: false },
      patch: { verified: 1, claimed: 1 },
    });
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
      ["claimed", "false", "true"],
    ]);
  });

  it("Dates compare at second precision (D1 stores timestamps in seconds)", () => {
    const rows = buildFieldHistoryRows({
      ...base,
      table: events,
      before: { startDate: new Date("2027-08-20T12:00:00.000Z") },
      patch: { startDate: new Date("2027-08-20T12:00:00.789Z") },
    });
    expect(rows).toEqual([]);
  });

  it("null and empty string are different values", () => {
    const rows = buildFieldHistoryRows({
      ...base,
      table: events,
      before: { description: null },
      patch: { description: "" },
    });
    expect(rows).toHaveLength(1);
  });

  it("rows of one call share a request id when none is given", () => {
    const rows = buildFieldHistoryRows({
      ...base,
      requestId: undefined,
      table: events,
      before: {},
      patch: { description: "a", ticketUrl: "b" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].requestId).toBeTruthy();
    expect(rows[0].requestId).toBe(rows[1].requestId);
  });
});

describe("helpers", () => {
  it("normalizeFieldValue", () => {
    expect(normalizeFieldValue(undefined)).toBeNull();
    expect(normalizeFieldValue(false)).toBe("false");
    expect(normalizeFieldValue(12)).toBe("12");
    expect(normalizeFieldValue(["a"])).toBe('["a"]');
  });

  it("systemActor", () => expect(systemActor("rescrape")).toBe("system:rescrape"));

  it("fieldHistoryBeforeSelect projects id + exactly the patched columns", () => {
    const sel = fieldHistoryBeforeSelect(events, {
      description: "x",
      updatedAt: new Date(),
      bogus: 1,
    });
    expect(Object.keys(sel).sort()).toEqual(["description", "id"]);
  });

  it("chunk size keeps an INSERT under D1's 100-parameter cap", () => {
    // 10 bound params per row (id + 9 columns).
    expect(FIELD_HISTORY_ROWS_PER_INSERT * 10).toBeLessThanOrEqual(100);
  });

  it("fieldHistoryInserts splits 10 rows into 2 statements, each under the cap", () => {
    const db = drizzle({} as never, { schema: {} as never }) as never;
    const rows = Array.from({ length: 10 }, (_, i) => ({
      entityType: "event" as const,
      entityId: "e1",
      field: `f${i}`,
      oldValue: null,
      newValue: String(i),
      actor: "u1",
      source: "test",
      requestId: "r1",
      changedAt: base.at,
    }));
    const stmts = fieldHistoryInserts(db, rows);
    expect(stmts).toHaveLength(2);
    for (const st of stmts) expect(st.toSQL().params.length).toBeLessThanOrEqual(100);
    expect(fieldHistoryInserts(db, [])).toHaveLength(0);
  });
});
