/**
 * OPE-830 — the write history, and the distinctions it exists to preserve.
 *
 * The instrument it replaces failed in two specific ways, and both have a test
 * here that fails if the replacement regresses to them:
 *
 *   - `enrichment_log` records SUCCESSES ONLY, so a refused save and a save
 *     that never happened were the same observation.
 *   - its `fields_changed` is `Object.keys(payload)`, identical on all 18
 *     saves of the specimen vendor and identical on a no-op resubmit.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { ALWAYS_IGNORED, VALUE_CAP, diffFields, recordEntityWrite } from "../entity-write-log";

const SCHEMA_SQL = `
  CREATE TABLE entity_write_log (
    id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    source TEXT NOT NULL, outcome TEXT NOT NULL, reject_reason TEXT,
    changes_json TEXT, actor_user_id TEXT, created_at INTEGER NOT NULL
  );
`;

let raw: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

const rows = () =>
  raw.prepare("SELECT * FROM entity_write_log ORDER BY rowid").all() as Array<{
    outcome: string;
    reject_reason: string | null;
    changes_json: string | null;
    actor_user_id: string | null;
  }>;

describe("diffFields — a change, not a payload key list", () => {
  it("reports only what actually moved", () => {
    // The defect being replaced: Object.keys() would report all three.
    const changes = diffFields(
      { city: "Bath", state: "ME", description: "same" },
      { city: "Bath", state: "NH", description: "same" }
    );
    expect(changes).toEqual([{ field: "state", before: "ME", after: "NH" }]);
  });

  it("⚠️ a no-op resubmit produces an EMPTY diff", () => {
    // The specimen vendor saved 18 times with a byte-identical field list.
    // If a resubmit still reports every field, this table is no better than
    // the column it replaces.
    const row = { city: "Bath", state: "ME", contactPhone: "" };
    expect(diffFields(row, { ...row })).toEqual([]);
  });

  it("⚠️ NULL and empty string are DIFFERENT", () => {
    // This distinction is what settled OPE-830: the specimen's empty columns
    // are '', which appears on only 31 of 7,067 vendor rows — so they were
    // written, not defaulted, which proved the write landed complete. A differ
    // treating them as equal would have destroyed that evidence.
    expect(diffFields({ city: null }, { city: "" })).toEqual([
      { field: "city", before: null, after: "" },
    ]);
    expect(diffFields({ city: "" }, { city: null })).toEqual([
      { field: "city", before: "", after: null },
    ]);
  });

  it("⚠️ an ABSENT key is not a deletion", () => {
    // A patch writer omits what it isn't changing. Treating absence as
    // "set to undefined" would report every unsent column as cleared.
    expect(diffFields({ city: "Bath", state: "ME" }, { city: "Bath" })).toEqual([]);
  });

  it("ignores updatedAt, or `noop` becomes unreachable", () => {
    // updatedAt is set on every save and is $onUpdateFn besides, so it always
    // differs. Leaving it in would make every resubmit look like a change and
    // silently disable the distinction this table exists for.
    const changes = diffFields(
      { city: "Bath", updatedAt: new Date("2026-01-01") },
      { city: "Bath", updatedAt: new Date("2026-09-06") },
      { ignore: ALWAYS_IGNORED }
    );
    expect(changes).toEqual([]);
  });

  it("a Date is stored as a readable ISO string, not JSON-quoted", () => {
    // Pins the `instanceof Date` branch. Without it a Date falls through to
    // JSON.stringify and is stored as "\"2026-01-01T…\"" — still COMPARES
    // correctly, so every equality test above stays green while the stored
    // value gains quotes nobody debugging a save would expect.
    const [c] = diffFields({ d: null }, { d: new Date("2026-01-01T00:00:00Z") });
    expect(c.after).toBe("2026-01-01T00:00:00.000Z");
  });

  it("compares dates and objects by value, not identity", () => {
    expect(diffFields({ d: new Date("2026-01-01") }, { d: new Date("2026-01-01") })).toEqual([]);
    expect(diffFields({ p: ["a"] }, { p: ["a"] })).toEqual([]);
    expect(diffFields({ p: ["a"] }, { p: ["a", "b"] })).toHaveLength(1);
  });

  it("caps long values and FLAGS the cut", () => {
    const long = "x".repeat(VALUE_CAP + 50);
    const [c] = diffFields({ description: "short" }, { description: long });
    expect(c.after).toHaveLength(VALUE_CAP);
    expect(c.truncated).toBe(true);
  });

  it("⚠️ does not flag truncation on a short value", () => {
    // Positive landmark. A `truncated: true` hard-wired on would make the flag
    // meaningless, and a value genuinely ending in "..." indistinguishable
    // from one we cut.
    const [c] = diffFields({ city: "Bath" }, { city: "Brunswick" });
    expect(c.truncated).toBeUndefined();
  });
});

describe("recordEntityWrite — outcome is explicit", () => {
  const base = { entityType: "vendor", entityId: "v1", source: "vendor_self" } as const;

  it("a real change is `applied`", async () => {
    await recordEntityWrite(db, {
      ...base,
      actorUserId: "u1",
      changes: [{ field: "city", before: null, after: "Bath" }],
    });
    const [r] = rows();
    expect(r.outcome).toBe("applied");
    expect(JSON.parse(r.changes_json!)).toHaveLength(1);
    expect(r.actor_user_id).toBe("u1");
  });

  it("an empty diff is `noop`, NOT `applied`", async () => {
    await recordEntityWrite(db, { ...base, changes: [] });
    const [r] = rows();
    expect(r.outcome).toBe("noop");
    expect(r.changes_json).toBe("[]");
  });

  it("⚠️ a refused save is a ROW, not an absence", async () => {
    // The whole point. Before this, a rejection left no trace, so "no record
    // of a save" and "no save attempted" were identical observations — which
    // is exactly what made OPE-830 unanswerable.
    await recordEntityWrite(db, {
      ...base,
      actorUserId: "u1",
      rejectReason: "email_unverified",
    });
    const [r] = rows();
    expect(r.outcome).toBe("rejected");
    expect(r.reject_reason).toBe("email_unverified");
  });

  it("⚠️ a rejected row's changes are NULL, never []", async () => {
    // Nothing was compared. `[]` would claim we compared and found no
    // differences — a different, false statement, and the same "two facts,
    // one value" collapse this table was built to remove.
    await recordEntityWrite(db, { ...base, rejectReason: "email_unverified" });
    expect(rows()[0].changes_json).toBeNull();
  });

  it("a reject reason wins over any changes passed alongside it", async () => {
    await recordEntityWrite(db, {
      ...base,
      rejectReason: "forbidden",
      changes: [{ field: "city", before: null, after: "Bath" }],
    });
    const [r] = rows();
    expect(r.outcome).toBe("rejected");
    expect(r.changes_json).toBeNull();
  });

  it("⚠️ never throws — an audit write must not fail the save", async () => {
    // It runs on the rejection path, where the request is already failing.
    // An instrument that can turn a 403 into a 500 is worse than none.
    raw.exec("DROP TABLE entity_write_log");
    await expect(recordEntityWrite(db, { ...base, changes: [] })).resolves.toBeUndefined();
  });
});
