/**
 * OPE-502 — SOURCE-first reads on list_event_citations.
 *
 * The pre-existing filters were all event-first, so "what else did this URL
 * produce" required listing every event and reading its citations — which
 * both fails to scale and silently misses any event outside whatever status
 * filter the sweep used. These tests pin the source-first behaviour, the
 * boundary semantics of the time window, and the two traps that make a naive
 * implementation wrong in production but green in CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventDataCitations, events, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
});

afterEach(() => {
  mock.restore();
});

function parseJson(result: unknown) {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

function seedEvent(id: string, name: string, slug: string, status = "APPROVED") {
  db.insert(promoters)
    .values({ id: `p-${id}`, companyName: `Promoter ${id}`, slug: `promoter-${id}` })
    .onConflictDoNothing()
    .run();
  db.insert(events)
    .values({ id, name, slug, promoterId: `p-${id}`, status })
    .run();
}

/** Fixed instants — never `Date.now()`, which rots the assertions over time. */
const T = (iso: string) => new Date(iso);

function seedCitation(over: Partial<typeof eventDataCitations.$inferInsert>) {
  db.insert(eventDataCitations)
    .values({
      id: over.id ?? crypto.randomUUID(),
      eventId: over.eventId!,
      fieldName: over.fieldName ?? "name",
      value: over.value ?? "some value",
      sourceUrl: over.sourceUrl ?? "https://example.com/",
      sourceType: over.sourceType ?? "user_submitted",
      state: over.state ?? "active",
      createdAt: over.createdAt ?? T("2026-08-01T12:00:00Z"),
      updatedAt: over.updatedAt ?? T("2026-08-01T12:00:00Z"),
      ...over,
    })
    .run();
}

/**
 * The worked example from the ticket: one event carrying three `name`
 * citations that each point at a different forms.gle URL, plus an APPROVED
 * sibling from the same source family that a PENDING-only sweep would miss.
 */
function seedFormsGleCorpus() {
  seedEvent("e-pending", "Pending Fair 2026", "pending-fair-2026", "PENDING");
  seedEvent("e-approved", "Approved Fair 2026", "approved-fair-2026", "APPROVED");
  seedEvent("e-other", "Unrelated Fair 2026", "unrelated-fair-2026", "APPROVED");

  seedCitation({ eventId: "e-pending", sourceUrl: "https://forms.gle/aaaaaaaa" });
  seedCitation({ eventId: "e-pending", sourceUrl: "https://forms.gle/bbbbbbbb" });
  seedCitation({ eventId: "e-pending", sourceUrl: "https://forms.gle/cccccccc" });
  seedCitation({ eventId: "e-approved", sourceUrl: "https://forms.gle/aaaaaaaa" });
  seedCitation({ eventId: "e-other", sourceUrl: "https://mainefairs.net/schedule" });
}

describe("list_event_citations — source-first filters", () => {
  it("returns every citation for a source family across all event statuses, in one call", async () => {
    seedFormsGleCorpus();

    const out = parseJson(
      await server.invoke("list_event_citations", { source_url_contains: "forms.gle" })
    );

    expect(out.count).toBe(4);
    expect(out.total_matching).toBe(4);
    // Spans a PENDING and an APPROVED event — the miss an event-first sweep makes.
    expect(new Set(out.citations.map((c: { event_id: string }) => c.event_id))).toEqual(
      new Set(["e-pending", "e-approved"])
    );
    expect(
      out.citations.every((c: { source_url: string }) => c.source_url.includes("forms.gle"))
    ).toBe(true);
  });

  it("carries the event's name, slug and status inline so no follow-up call is needed", async () => {
    seedFormsGleCorpus();

    const out = parseJson(
      await server.invoke("list_event_citations", { source_url: "https://forms.gle/aaaaaaaa" })
    );

    expect(out.count).toBe(2);
    const byStatus = Object.fromEntries(
      out.citations.map((c: { event_status: string; event_name: string }) => [
        c.event_status,
        c.event_name,
      ])
    );
    expect(byStatus).toEqual({
      PENDING: "Pending Fair 2026",
      APPROVED: "Approved Fair 2026",
    });
    expect(out.citations.every((c: { event_slug: string }) => c.event_slug.endsWith("-2026"))).toBe(
      true
    );
  });

  it("substring match is case-insensitive and matches mid-URL, not just the prefix", async () => {
    seedEvent("e1", "E1", "e1");
    seedCitation({ eventId: "e1", sourceUrl: "https://DOCS.google.com/forms/d/e/xyz/viewform" });

    const upper = parseJson(
      await server.invoke("list_event_citations", { source_url_contains: "Docs.Google.com" })
    );
    expect(upper.count).toBe(1);

    const mid = parseJson(
      await server.invoke("list_event_citations", { source_url_contains: "/forms/d/" })
    );
    expect(mid.count).toBe(1);
  });

  it("exact source_url does not match a longer URL that merely starts with it", async () => {
    seedEvent("e1", "E1", "e1");
    seedCitation({ eventId: "e1", sourceUrl: "https://example.com/fair" });
    seedCitation({ eventId: "e1", sourceUrl: "https://example.com/fair/2026" });

    const out = parseJson(
      await server.invoke("list_event_citations", { source_url: "https://example.com/fair" })
    );
    expect(out.count).toBe(1);
    expect(out.citations[0].source_url).toBe("https://example.com/fair");
  });

  it("filters by source_name and source_type", async () => {
    seedEvent("e1", "E1", "e1");
    seedCitation({ eventId: "e1", sourceName: "Fair Website", sourceType: "official_website" });
    seedCitation({ eventId: "e1", sourceName: "Local Paper", sourceType: "news_article" });

    expect(
      parseJson(await server.invoke("list_event_citations", { source_name: "Local Paper" })).count
    ).toBe(1);
    expect(
      parseJson(await server.invoke("list_event_citations", { source_type: "official_website" }))
        .count
    ).toBe(1);
  });
});

describe("list_event_citations — creation window", () => {
  beforeEach(() => {
    seedEvent("e1", "E1", "e1");
    seedCitation({ id: "c-before", eventId: "e1", createdAt: T("2026-07-31T23:59:59Z") });
    seedCitation({ id: "c-start", eventId: "e1", createdAt: T("2026-08-01T00:00:00Z") });
    seedCitation({ id: "c-mid", eventId: "e1", createdAt: T("2026-08-15T12:00:00Z") });
    seedCitation({ id: "c-end", eventId: "e1", createdAt: T("2026-09-01T00:00:00Z") });
  });

  it("is half-open [after, before) so adjacent windows tile without double-counting", async () => {
    const aug = parseJson(
      await server.invoke("list_event_citations", {
        created_after: "2026-08-01T00:00:00Z",
        created_before: "2026-09-01T00:00:00Z",
      })
    );
    // c-start included (inclusive lower bound), c-end excluded (exclusive upper).
    expect(new Set(aug.citations.map((c: { id: string }) => c.id))).toEqual(
      new Set(["c-start", "c-mid"])
    );

    const sep = parseJson(
      await server.invoke("list_event_citations", { created_after: "2026-09-01T00:00:00Z" })
    );
    expect(sep.citations.map((c: { id: string }) => c.id)).toEqual(["c-end"]);
  });

  it("boundary rows are judged on the stored instant, not a rendered date (OPE-482)", async () => {
    // 2026-08-01T00:00:00Z formats as Jul 31 in US Eastern. A window filtered
    // on rendered text would drop c-start here and include c-before.
    const out = parseJson(
      await server.invoke("list_event_citations", {
        created_after: "2026-08-01T00:00:00Z",
        created_before: "2026-08-01T00:00:01Z",
      })
    );
    expect(out.citations.map((c: { id: string }) => c.id)).toEqual(["c-start"]);
  });

  it("rejects an unparseable instant instead of silently returning the unwindowed set", async () => {
    const r = (await server.invoke("list_event_citations", {
      created_after: "last tuesday",
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("created_after");
    // The dangerous outcome is a full unfiltered list presented as a window.
    expect(r.content[0].text).not.toContain('"citations"');
  });
});

describe("list_event_citations — confidence bounds and the NULL hole", () => {
  beforeEach(() => {
    seedEvent("e1", "E1", "e1");
    seedCitation({ id: "c-low", eventId: "e1", confidence: 0.2 });
    seedCitation({ id: "c-high", eventId: "e1", confidence: 0.9 });
    seedCitation({ id: "c-null", eventId: "e1", confidence: null });
  });

  it("numeric bounds exclude unscored rows — the documented, deliberate gap", async () => {
    const low = parseJson(await server.invoke("list_event_citations", { confidence_lt: 0.5 }));
    expect(low.citations.map((c: { id: string }) => c.id)).toEqual(["c-low"]);
    expect(low.citations.map((c: { id: string }) => c.id)).not.toContain("c-null");
  });

  it("confidence_missing reaches the rows the bounds never can", async () => {
    const out = parseJson(
      await server.invoke("list_event_citations", { confidence_missing: true })
    );
    expect(out.citations.map((c: { id: string }) => c.id)).toEqual(["c-null"]);
  });

  it("confidence_gt is strict", async () => {
    const out = parseJson(await server.invoke("list_event_citations", { confidence_gt: 0.9 }));
    expect(out.count).toBe(0);
  });
});

describe("list_event_citations — blast radius and truncation", () => {
  it("group_by_source answers 'N citations across M events' in one call", async () => {
    seedFormsGleCorpus();

    const out = parseJson(
      await server.invoke("list_event_citations", {
        source_url_contains: "forms.gle",
        group_by_source: true,
      })
    );

    expect(out.grouped_by).toBe("source_url");
    const aaa = out.sources.find(
      (s: { source_url: string }) => s.source_url === "https://forms.gle/aaaaaaaa"
    );
    expect(aaa).toMatchObject({ citations: 2, events: 2 });
    // Sorted by citation count desc — the widest blast radius first.
    expect(out.sources[0].source_url).toBe("https://forms.gle/aaaaaaaa");
    expect(out.sources.map((s: { source_url: string }) => s.source_url)).not.toContain(
      "https://mainefairs.net/schedule"
    );
  });

  it("rollup timestamps are ISO strings, not raw seconds", async () => {
    seedEvent("e1", "E1", "e1");
    seedCitation({ eventId: "e1", createdAt: T("2026-08-01T12:00:00Z") });
    seedCitation({ eventId: "e1", createdAt: T("2026-08-05T12:00:00Z") });

    const out = parseJson(await server.invoke("list_event_citations", { group_by_source: true }));
    expect(out.sources[0].first_seen).toBe("2026-08-01T12:00:00.000Z");
    expect(out.sources[0].last_seen).toBe("2026-08-05T12:00:00.000Z");
  });

  it("reports total_matching and truncated rather than making the caller infer a cap", async () => {
    seedEvent("e1", "E1", "e1");
    for (let i = 0; i < 5; i++) {
      seedCitation({ eventId: "e1", sourceUrl: `https://example.com/${i}` });
    }

    const page1 = parseJson(await server.invoke("list_event_citations", { limit: 2 }));
    expect(page1).toMatchObject({ count: 2, total_matching: 5, offset: 0, truncated: true });

    const page3 = parseJson(await server.invoke("list_event_citations", { limit: 2, offset: 4 }));
    expect(page3).toMatchObject({ count: 1, total_matching: 5, offset: 4, truncated: false });
  });

  it("paging is stable when many citations share one created_at second", async () => {
    seedEvent("e1", "E1", "e1");
    const same = T("2026-08-01T12:00:00Z");
    for (let i = 0; i < 6; i++) {
      seedCitation({ id: `c-${i}`, eventId: "e1", createdAt: same, updatedAt: same });
    }

    const ids: string[] = [];
    for (let off = 0; off < 6; off += 2) {
      const p = parseJson(await server.invoke("list_event_citations", { limit: 2, offset: off }));
      ids.push(...p.citations.map((c: { id: string }) => c.id));
    }
    // No row repeated, none dropped — which is what the id tiebreaker buys.
    expect(new Set(ids).size).toBe(6);
  });
});

describe("list_event_citations — existing callers are unaffected", () => {
  it("event_id-only still returns active citations for that event", async () => {
    seedFormsGleCorpus();
    seedCitation({ eventId: "e-pending", state: "rejected", sourceUrl: "https://old.example/" });

    const out = parseJson(await server.invoke("list_event_citations", { event_id: "e-pending" }));
    expect(out.count).toBe(3);
    expect(out.citations.every((c: { state: string }) => c.state === "active")).toBe(true);

    const all = parseJson(
      await server.invoke("list_event_citations", {
        event_id: "e-pending",
        include_all_states: true,
      })
    );
    expect(all.count).toBe(4);
  });
});

/**
 * A source-level guard, because this one cannot be caught by behaviour.
 *
 * D1 caps a LIKE pattern at 50 characters; local SQLite's cap is 50,000. A
 * LIKE-based substring filter therefore passes every test in this file and
 * throws LIKE_PATTERN_TOO_COMPLEX in production the first time somebody
 * pastes a full source_url — which is routinely longer than 50 characters.
 * The only defence available at test time is asserting the implementation
 * never took that route.
 */
describe("list_event_citations — D1 LIKE cap guard", () => {
  it("matches substrings with instr(), never LIKE", () => {
    const src = readFileSync(new URL("../src/tools/admin-citations.ts", import.meta.url), "utf8");
    const tool = src.slice(
      src.indexOf('"list_event_citations"'),
      src.indexOf('"update_event_citation"')
    );
    expect(tool.length).toBeGreaterThan(1000); // the slice actually found the tool
    expect(tool).toContain("instr(lower(");

    // Strip comments before matching: the implementation's own note explains
    // WHY LIKE is avoided, and a naive scan would flag that explanation as
    // the violation it warns about.
    const code = tool.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bLIKE\b/i);
  });
});
