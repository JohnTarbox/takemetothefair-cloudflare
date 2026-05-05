import { describe, it, expect, vi, beforeEach } from "vitest";

const insertedRows: unknown[] = [];
const updateCalls: Array<{ where: unknown; set: unknown }> = [];

const insertChain = {
  values: vi.fn(async (v: unknown) => {
    insertedRows.push(v);
  }),
};

const updateChain = {
  set: vi.fn(function (this: typeof updateChain, set: unknown) {
    (this as unknown as { _set: unknown })._set = set;
    return this;
  }),
  where: vi.fn(async function (this: typeof updateChain, w: unknown) {
    updateCalls.push({
      where: w,
      set: (this as unknown as { _set: unknown })._set,
    });
  }),
};

const mockDb = {
  insert: vi.fn(() => insertChain),
  update: vi.fn(() => updateChain),
};

import { logEnrichment } from "../enrichment-log";
type TestDb = Parameters<typeof logEnrichment>[0];

beforeEach(() => {
  insertedRows.length = 0;
  updateCalls.length = 0;
  vi.clearAllMocks();
});

describe("logEnrichment", () => {
  it("inserts a log row with attemptedAt + finishedAt for success", async () => {
    await logEnrichment(mockDb as unknown as TestDb, {
      targetType: "vendor",
      targetId: "v-1",
      source: "ai_workers",
      status: "success",
    });
    expect(insertedRows.length).toBe(1);
    const row = insertedRows[0] as Record<string, unknown>;
    expect(row.targetType).toBe("vendor");
    expect(row.source).toBe("ai_workers");
    expect(row.status).toBe("success");
    expect(row.attemptedAt).toBeInstanceOf(Date);
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it("leaves finishedAt null for status=skipped", async () => {
    await logEnrichment(mockDb as unknown as TestDb, {
      targetType: "vendor",
      targetId: "v-2",
      source: "scraper",
      status: "skipped",
    });
    const row = insertedRows[0] as Record<string, unknown>;
    expect(row.finishedAt).toBeNull();
  });

  it("serializes fieldsChanged as JSON", async () => {
    await logEnrichment(mockDb as unknown as TestDb, {
      targetType: "vendor",
      targetId: "v-3",
      source: "manual_admin",
      status: "success",
      fieldsChanged: ["description", "logoUrl"],
    });
    const row = insertedRows[0] as Record<string, unknown>;
    expect(row.fieldsChanged).toBe('["description","logoUrl"]');
  });

  it("updates vendor.enrichmentSource + enrichmentAttemptedAt on vendor success", async () => {
    await logEnrichment(mockDb as unknown as TestDb, {
      targetType: "vendor",
      targetId: "v-4",
      source: "vendor_self",
      status: "success",
    });
    expect(updateCalls.length).toBe(1);
    const set = updateCalls[0].set as Record<string, unknown>;
    expect(set.enrichmentSource).toBe("vendor_self");
    expect(set.enrichmentAttemptedAt).toBeInstanceOf(Date);
  });

  it("does NOT update vendor cols on failure", async () => {
    await logEnrichment(mockDb as unknown as TestDb, {
      targetType: "vendor",
      targetId: "v-5",
      source: "ai_workers",
      status: "failure",
      notes: "AI extractor returned empty",
    });
    expect(updateCalls.length).toBe(0);
  });

  it("does NOT update vendor cols for event targets", async () => {
    await logEnrichment(mockDb as unknown as TestDb, {
      targetType: "event",
      targetId: "e-1",
      source: "ai_workers",
      status: "success",
    });
    expect(updateCalls.length).toBe(0);
  });
});
