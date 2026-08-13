import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `refreshIssues` pulls from three integration-bound clients. Mock them
// at the module boundary so the reconciliation logic can be exercised
// without needing real Bing/GSC fixtures. Each test wires the return
// values it needs.
const getSiteScanIssuesMock = vi.fn();
const getBingSitemapsMock = vi.fn();
const getSitemapStatusMock = vi.fn();

vi.mock("@/lib/bing-webmaster", () => ({
  getSiteScanIssues: (...args: unknown[]) => getSiteScanIssuesMock(...args),
  getSitemaps: (...args: unknown[]) => getBingSitemapsMock(...args),
}));
vi.mock("@/lib/search-console", () => ({
  getSitemapStatus: (...args: unknown[]) => getSitemapStatusMock(...args),
}));

import {
  fingerprintFor,
  snoozeIssue,
  unsnoozeIssue,
  getCurrentIssues,
  refreshIssues,
} from "../site-health";

// site-health.ts is the unified panel for Bing/GSC issue aggregation.
// `refreshIssues` depends on three integration-bound sources
// (bing-webmaster, search-console) and is exercised through admin
// E2E tests; covering it here would mean mocking three full clients.
// This file covers the four pure / DB-only public exports:
//   fingerprintFor, snoozeIssue, unsnoozeIssue, getCurrentIssues.

interface QueryChain {
  from: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
}

interface InsertChain {
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
}

interface DeleteChain {
  where: ReturnType<typeof vi.fn>;
}

interface FakeDb {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  // Captured call arguments for assertions.
  __selectRows: unknown[];
  __insertCalls: Array<{ values: unknown; onConflictDoUpdate?: unknown }>;
  __deleteCalls: Array<{ where: unknown }>;
}

function makeDb(selectRows: unknown[] = []): FakeDb {
  const insertCalls: Array<{ values: unknown; onConflictDoUpdate?: unknown }> = [];
  const deleteCalls: Array<{ where: unknown }> = [];

  const queryChain: QueryChain = {
    from: vi.fn(() => queryChain),
    leftJoin: vi.fn(() => queryChain),
    where: vi.fn(() => queryChain),
    orderBy: vi.fn(async () => selectRows),
  };

  const makeInsertChain = (): InsertChain => {
    const captured: { values: unknown; onConflictDoUpdate?: unknown } = { values: undefined };
    insertCalls.push(captured);
    const chain: InsertChain = {
      values: vi.fn((v: unknown) => {
        captured.values = v;
        return chain;
      }),
      onConflictDoUpdate: vi.fn(async (cfg: unknown) => {
        captured.onConflictDoUpdate = cfg;
        return undefined;
      }),
    };
    return chain;
  };

  const makeDeleteChain = (): DeleteChain => {
    const captured: { where: unknown } = { where: undefined };
    deleteCalls.push(captured);
    return {
      where: vi.fn(async (w: unknown) => {
        captured.where = w;
        return undefined;
      }),
    };
  };

  return {
    select: vi.fn(() => queryChain),
    insert: vi.fn(() => makeInsertChain()),
    delete: vi.fn(() => makeDeleteChain()),
    __selectRows: selectRows,
    __insertCalls: insertCalls,
    __deleteCalls: deleteCalls,
  };
}

type DbArg = Parameters<typeof getCurrentIssues>[0];

describe("fingerprintFor", () => {
  it("is deterministic across calls with the same input", async () => {
    const a = await fingerprintFor("BING_SCAN", "BROKEN_LINK", "https://example.com/a");
    const b = await fingerprintFor("BING_SCAN", "BROKEN_LINK", "https://example.com/a");
    expect(a).toBe(b);
  });

  it("normalizes URL casing so trivial casing variations don't fragment snoozes", async () => {
    const lower = await fingerprintFor("BING_SCAN", "BROKEN_LINK", "https://example.com/Path");
    const upper = await fingerprintFor("BING_SCAN", "BROKEN_LINK", "HTTPS://EXAMPLE.COM/PATH");
    expect(lower).toBe(upper);
  });

  it("returns different fingerprints when source differs", async () => {
    const a = await fingerprintFor("BING_SCAN", "X", "https://example.com/");
    const b = await fingerprintFor("GSC_SITEMAP", "X", "https://example.com/");
    expect(a).not.toBe(b);
  });

  it("returns different fingerprints when issueType differs", async () => {
    const a = await fingerprintFor("BING_SCAN", "ERR_A", "https://example.com/");
    const b = await fingerprintFor("BING_SCAN", "ERR_B", "https://example.com/");
    expect(a).not.toBe(b);
  });

  it("returns different fingerprints when URL differs", async () => {
    const a = await fingerprintFor("BING_SCAN", "X", "https://example.com/a");
    const b = await fingerprintFor("BING_SCAN", "X", "https://example.com/b");
    expect(a).not.toBe(b);
  });

  it("treats null URL as a stable input (different from empty string but stable)", async () => {
    const a = await fingerprintFor("BING_SCAN", "X", null);
    const b = await fingerprintFor("BING_SCAN", "X", null);
    expect(a).toBe(b);
    // A 32-char hex slice — fixed length regardless of input.
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("snoozeIssue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T20:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("inserts a snooze row with snoozedUntil = now + days*86400", async () => {
    const db = makeDb();
    await snoozeIssue(db as unknown as DbArg, "fp-1", 7, "user-1");

    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = db.__insertCalls[0].values as {
      fingerprint: string;
      snoozedUntil: Date;
      snoozedBy: string;
      snoozedAt: Date;
      note: string | null;
    };
    expect(inserted.fingerprint).toBe("fp-1");
    expect(inserted.snoozedBy).toBe("user-1");
    expect(inserted.note).toBeNull();
    // 7 days in ms (post-0043 ms-epoch convention)
    expect(inserted.snoozedUntil.getTime() - inserted.snoozedAt.getTime()).toBe(7 * 86400 * 1000);
  });

  it("includes the note when provided", async () => {
    const db = makeDb();
    await snoozeIssue(db as unknown as DbArg, "fp-2", 3, "user-1", "follow up next sprint");

    const inserted = db.__insertCalls[0].values as { note: string };
    expect(inserted.note).toBe("follow up next sprint");
  });

  it("uses ON CONFLICT to update the existing row (UPSERT semantics)", async () => {
    const db = makeDb();
    await snoozeIssue(db as unknown as DbArg, "fp-3", 14, "user-2", "extend");

    const conflictCfg = db.__insertCalls[0].onConflictDoUpdate as {
      set: { snoozedUntil: number; snoozedBy: string; note: string };
    };
    // Same fingerprint twice should overwrite, not duplicate. The set
    // payload mirrors the insert payload (minus fingerprint).
    expect(conflictCfg.set.snoozedBy).toBe("user-2");
    expect(conflictCfg.set.note).toBe("extend");
  });
});

describe("unsnoozeIssue", () => {
  it("issues a DELETE on the snoozes table for the given fingerprint", async () => {
    const db = makeDb();
    await unsnoozeIssue(db as unknown as DbArg, "fp-1");
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.__deleteCalls).toHaveLength(1);
  });
});

describe("getCurrentIssues", () => {
  // Post-0043: timestamp columns return Date objects, not seconds.
  const now = new Date();

  function makeRow(
    overrides: Partial<{
      fingerprint: string;
      source: string;
      issueType: string;
      severity: string;
      url: string | null;
      message: string | null;
      snoozedUntil: Date | null;
    }> = {}
  ) {
    return {
      fingerprint: "fp-default",
      source: "BING_SCAN",
      issueType: "BROKEN_LINK",
      severity: "ERROR",
      url: "https://example.com/",
      message: null,
      firstDetectedAt: new Date(now.getTime() - 86400 * 1000),
      lastDetectedAt: new Date(now.getTime() - 3600 * 1000),
      resolvedAt: null,
      snoozedUntil: null,
      ...overrides,
    };
  }

  it("returns all rows when no filters apply", async () => {
    const db = makeDb([
      makeRow({ fingerprint: "a" }),
      makeRow({ fingerprint: "b", source: "GSC_SITEMAP" }),
    ]);
    const rows = await getCurrentIssues(db as unknown as DbArg);
    expect(rows.map((r) => r.fingerprint)).toEqual(["a", "b"]);
  });

  it("filters by source", async () => {
    const db = makeDb([
      makeRow({ fingerprint: "a", source: "BING_SCAN" }),
      makeRow({ fingerprint: "b", source: "GSC_SITEMAP" }),
      makeRow({ fingerprint: "c", source: "BING_SCAN" }),
    ]);
    const rows = await getCurrentIssues(db as unknown as DbArg, { source: "BING_SCAN" });
    expect(rows.map((r) => r.fingerprint)).toEqual(["a", "c"]);
  });

  it("filters by severity", async () => {
    const db = makeDb([
      makeRow({ fingerprint: "a", severity: "ERROR" }),
      makeRow({ fingerprint: "b", severity: "WARNING" }),
      makeRow({ fingerprint: "c", severity: "ERROR" }),
    ]);
    const rows = await getCurrentIssues(db as unknown as DbArg, { severity: "ERROR" });
    expect(rows.map((r) => r.fingerprint)).toEqual(["a", "c"]);
  });

  it("hides actively-snoozed rows when hideSnoozed=true", async () => {
    const db = makeDb([
      makeRow({
        fingerprint: "active-snooze",
        snoozedUntil: new Date(now.getTime() + 3600 * 1000),
      }), // future
      makeRow({
        fingerprint: "expired-snooze",
        snoozedUntil: new Date(now.getTime() - 3600 * 1000),
      }), // past
      makeRow({ fingerprint: "no-snooze", snoozedUntil: null }),
    ]);
    const rows = await getCurrentIssues(db as unknown as DbArg, { hideSnoozed: true });
    // Active snoozes hidden; expired snoozes still surface (they're due
    // for re-action) along with un-snoozed rows.
    expect(rows.map((r) => r.fingerprint).sort()).toEqual(["expired-snooze", "no-snooze"]);
  });

  it("does NOT hide snoozed rows by default (admin needs to see them)", async () => {
    const db = makeDb([
      makeRow({
        fingerprint: "active-snooze",
        snoozedUntil: new Date(now.getTime() + 3600 * 1000),
      }),
    ]);
    const rows = await getCurrentIssues(db as unknown as DbArg);
    expect(rows).toHaveLength(1);
  });
});

describe("refreshIssues", () => {
  // refreshIssues uses a different DB shape than getCurrentIssues
  // (it calls .update().set().where() and .insert().values() directly,
  // not through the leftJoin+orderBy path), so we build a separate mock.
  interface RefreshDb {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    __openRows: unknown[];
    __inserts: unknown[];
    __updates: unknown[];
  }

  function makeRefreshDb(openRows: unknown[] = []): RefreshDb {
    const inserts: unknown[] = [];
    const updates: unknown[] = [];

    const selectChain = {
      from: vi.fn(() => selectChain),
      where: vi.fn(async () => openRows),
    };

    // Drizzle's .values() returns a thenable builder, so it can be either
    // awaited directly (the health_issues inserts) or chained into
    // .onConflictDoUpdate() (the site_health_refresh_state upsert). The mock
    // has to be both, or the run-state stamp looks like a crash.
    const makeInsertChain = () => {
      const chain = {
        values: vi.fn((v: unknown) => {
          inserts.push(v);
          const built = {
            onConflictDoUpdate: vi.fn(async () => undefined),
            then: (resolve: (value: undefined) => unknown) => resolve(undefined),
          };
          return built;
        }),
      };
      return chain;
    };

    const makeUpdateChain = () => {
      const captured: { set?: unknown } = {};
      const chain = {
        set: vi.fn((v: unknown) => {
          captured.set = v;
          return chain;
        }),
        where: vi.fn(async () => {
          updates.push(captured.set);
        }),
      };
      return chain;
    };

    return {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => makeInsertChain()),
      update: vi.fn(() => makeUpdateChain()),
      __openRows: openRows,
      __inserts: inserts,
      __updates: updates,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zero counts when all sources return empty and no open rows exist", async () => {
    getSiteScanIssuesMock.mockResolvedValue([]);
    getBingSitemapsMock.mockResolvedValue([]);
    getSitemapStatusMock.mockResolvedValue({ sitemaps: [] });

    const db = makeRefreshDb([]);
    const result = await refreshIssues(
      db as unknown as Parameters<typeof refreshIssues>[0],
      {} as Parameters<typeof refreshIssues>[1],
      {} as Parameters<typeof refreshIssues>[2]
    );

    expect(result).toEqual({ inserted: 0, updated: 0, resolved: 0, failedSources: [] });
  });

  it("contains a single source's failure without breaking the panel", async () => {
    // Bing throws — should be caught + warned, GSC still flows through.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getSiteScanIssuesMock.mockRejectedValue(new Error("Bing 503"));
    getBingSitemapsMock.mockResolvedValue([]);
    getSitemapStatusMock.mockResolvedValue({
      sitemaps: [{ path: "https://example.com/sitemap.xml", errors: 2, warnings: 0 }],
    });

    const db = makeRefreshDb([]);
    const result = await refreshIssues(
      db as unknown as Parameters<typeof refreshIssues>[0],
      {} as Parameters<typeof refreshIssues>[1],
      {} as Parameters<typeof refreshIssues>[2]
    );

    // The GSC error survived — one new issue inserted.
    expect(result.inserted).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("inserts new fresh issues and resolves stale open issues", async () => {
    // Fresh: a single GSC error.
    getSiteScanIssuesMock.mockResolvedValue([]);
    getBingSitemapsMock.mockResolvedValue([]);
    getSitemapStatusMock.mockResolvedValue({
      sitemaps: [{ path: "/sitemap.xml", errors: 1, warnings: 0 }],
    });

    // Stored open: one different fingerprint that's no longer surfacing.
    const db = makeRefreshDb([
      {
        id: "id-stale",
        fingerprint: "stale-fp-not-in-fresh-batch",
        source: "BING_SCAN",
        issueType: "OLD",
        url: null,
      },
    ]);

    const result = await refreshIssues(
      db as unknown as Parameters<typeof refreshIssues>[0],
      {} as Parameters<typeof refreshIssues>[1],
      {} as Parameters<typeof refreshIssues>[2]
    );

    // Fresh GSC issue → inserted = 1. The stale open row → resolved = 1.
    expect(result.inserted).toBe(1);
    expect(result.resolved).toBe(1);
  });

  // ── OPE-309 A7/A8 — proof of execution ──────────────────────────────
  //
  // In production this is the ONLY output the refresh produces: BING_SCAN /
  // BING_SITEMAP / GSC_SITEMAP have never written a health_issues row, because
  // Bing reports no crawl issues and every sitemap reads Success. If the
  // all-clear run stopped stamping, a dead cron would be invisible.
  it("stamps run state even when every source is clean and nothing is written", async () => {
    getSiteScanIssuesMock.mockResolvedValue([]);
    getBingSitemapsMock.mockResolvedValue([]);
    getSitemapStatusMock.mockResolvedValue({ sitemaps: [] });

    const db = makeRefreshDb([]);
    await refreshIssues(
      db as unknown as Parameters<typeof refreshIssues>[0],
      {} as Parameters<typeof refreshIssues>[1],
      {} as Parameters<typeof refreshIssues>[2]
    );

    const stamp = db.__inserts.find(
      (i): i is { id: string; lastRunAt: Date; lastFailedSources: number } =>
        typeof i === "object" && i !== null && (i as { id?: unknown }).id === "default"
    );
    expect(stamp).toBeDefined();
    expect(stamp!.lastRunAt).toBeInstanceOf(Date);
    expect(stamp!.lastFailedSources).toBe(0);
  });

  // ── OPE-309 — the false-resolve guard ───────────────────────────────
  //
  // The pair below is the whole point: identical open row, identical empty
  // fresh batch, and the ONLY difference is whether the collector threw or
  // answered. "We could not look" must not be recorded as "fixed".
  it("does NOT resolve a source's rows when that source's collector threw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getSiteScanIssuesMock.mockRejectedValue(new Error("Bing 503"));
    getBingSitemapsMock.mockResolvedValue([]);
    getSitemapStatusMock.mockResolvedValue({ sitemaps: [] });

    const db = makeRefreshDb([
      { id: "id-1", fingerprint: "fp-bing", source: "BING_SCAN", issueType: "X", url: null },
    ]);
    const result = await refreshIssues(
      db as unknown as Parameters<typeof refreshIssues>[0],
      {} as Parameters<typeof refreshIssues>[1],
      {} as Parameters<typeof refreshIssues>[2]
    );

    expect(result.resolved).toBe(0);
    expect(result.failedSources).toContain("BING_SCAN");

    const stamp = db.__inserts.find(
      (i): i is { id: string; lastFailedSourceNames: string } =>
        typeof i === "object" && i !== null && (i as { id?: unknown }).id === "default"
    );
    expect(stamp!.lastFailedSourceNames).toBe("BING_SCAN");
    warnSpy.mockRestore();
  });

  it("DOES resolve the same row when the collector answers cleanly", async () => {
    // The complement — proves the guard above keys on the failure, not on the
    // emptiness of the batch.
    getSiteScanIssuesMock.mockResolvedValue([]);
    getBingSitemapsMock.mockResolvedValue([]);
    getSitemapStatusMock.mockResolvedValue({ sitemaps: [] });

    const db = makeRefreshDb([
      { id: "id-1", fingerprint: "fp-bing", source: "BING_SCAN", issueType: "X", url: null },
    ]);
    const result = await refreshIssues(
      db as unknown as Parameters<typeof refreshIssues>[0],
      {} as Parameters<typeof refreshIssues>[1],
      {} as Parameters<typeof refreshIssues>[2]
    );

    expect(result.resolved).toBe(1);
    expect(result.failedSources).toEqual([]);
  });
});
