/**
 * OPE-593 — the fifth D1 cap: expression tree depth 100.
 *
 * `search_events`' fuzzy path built one predicate per query token and OR'd
 * them together. `tokenize()` has no ceiling and `params.query` is free text,
 * and `nameOrVariantLike` is itself `or(like, EXISTS)` — so each token cost
 * about TWO levels of expression depth against a D1 cap of 100. Roughly 50
 * tokens, an ordinary pasted event blurb, would have thrown
 * `Expression tree is too large (maximum depth 100)`.
 *
 * Measured by bracketing against the live production database on 2026-08-28:
 * a 99-term OR chain succeeds, ~120 throws. See `docs/d1-statement-limits.md`.
 *
 * ── Why this asserts SQL SHAPE and not "it did not throw" ───────────────────
 * A behavioural test CANNOT catch this, and the file next door already proved
 * it: better-sqlite3 runs with SQLite's own defaults (depth 1000, 32766 bind
 * params, 50000-char LIKE patterns), so the statement D1 rejects executes
 * happily in-process. OPE-517's followup verified exactly that — "150 rows,
 * call fuzzy search, expect no throw" passed with the fix reverted, 4/4 green.
 *
 * So the guard is structural: however long the query, the statement must not
 * contain more than a bounded number of OR'd token predicates.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPublicTools } from "../src/tools/public.js";
import { events, promoters } from "../src/schema.js";

/** D1's measured expression-depth ceiling. */
const D1_MAX_EXPR_DEPTH = 100;

/** The cap `public.ts` applies. Duplicated deliberately — if the constant there
 *  is raised without thinking, this number stops matching and the test says so. */
const MAX_FUZZY_TOKENS = 24;

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let server: CapturingMcpServer;
let prepared: string[];

beforeEach(() => {
  ({ db, raw } = createTestDb());
  prepared = [];
  const originalPrepare = raw.prepare.bind(raw);
  (raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    prepared.push(sql);
    return originalPrepare(sql);
  };
  server = new CapturingMcpServer();
  registerPublicTools(server as never, db);
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p" }).run();
  const future = new Date(Date.now() + 30 * 86400_000);
  db.insert(events)
    .values({
      id: "9a395062-0000-4000-8000-000000000001",
      name: "Harborside Festival",
      slug: "harborside-festival",
      promoterId: "p-1",
      status: "APPROVED",
      startDate: future,
      endDate: future,
    })
    .run();
});

/**
 * The main search statement — the one that selects FROM events.
 *
 * Not `includes("event_name_variants")`: the variants LOOKUP statement matches
 * that too, and counting it would make these assertions measure the wrong
 * query. Same trap the sibling file documents in the other direction.
 */
function mainSearchStatement(): string {
  const hits = prepared.filter((s) => /from\s+"events"/i.test(s) && /event_name_variants/i.test(s));
  expect(hits.length).toBeGreaterThan(0);
  return hits[0];
}

/** One per `nameOrVariantLike` term — i.e. one per token, plus the whole-query term. */
const orTermCount = (sql: string) => (sql.match(/event_name_variants/gi) ?? []).length;

/** A query with `n` distinct significant tokens (no stop words, years, ordinals). */
const longQuery = (n: number) =>
  Array.from({ length: n }, (_, i) => `alpha${String(i).padStart(3, "0")}bravo`).join(" ");

describe("OPE-593 — the fuzzy OR chain is bounded regardless of query length", () => {
  it("the fixture really is long enough to blow the cap — else this proves nothing", () => {
    // 60 tokens x ~2 depth each is comfortably past 100. If this fixture were
    // short the assertions below would pass with the cap deleted.
    expect(60 * 2).toBeGreaterThan(D1_MAX_EXPR_DEPTH);
  });

  it("a 60-token query produces at most MAX_FUZZY_TOKENS + 1 OR'd terms", async () => {
    await server.invoke("search_events", { query: longQuery(60), fuzzy: true });
    const terms = orTermCount(mainSearchStatement());
    // +1 for the whole-query LIKE that preserves the OPE-434 superset invariant.
    expect(terms).toBeLessThanOrEqual(MAX_FUZZY_TOKENS + 1);
  });

  it("a 200-token query is bounded by the same number, not by the input", async () => {
    // The property is that the statement's size stops tracking the input at
    // all. A cap that merely trimmed "a bit" would still scale.
    await server.invoke("search_events", { query: longQuery(200), fuzzy: true });
    expect(orTermCount(mainSearchStatement())).toBeLessThanOrEqual(MAX_FUZZY_TOKENS + 1);
  });

  it("stays well inside the depth ceiling at ~2 levels per term", async () => {
    await server.invoke("search_events", { query: longQuery(200), fuzzy: true });
    expect(orTermCount(mainSearchStatement()) * 2).toBeLessThan(D1_MAX_EXPR_DEPTH);
  });

  it("a short query is untouched — the cap must not narrow ordinary searches", async () => {
    await server.invoke("search_events", { query: "Harborside Festival", fuzzy: true });
    // 2 tokens + the whole-query term.
    expect(orTermCount(mainSearchStatement())).toBe(3);
  });

  it("still returns the match for an ordinary query", async () => {
    const res = (await server.invoke("search_events", {
      query: "Harborside Festival",
      fuzzy: true,
    })) as { content: Array<{ text: string }> };
    const out = JSON.parse(res.content[0].text);
    const list = (out as { events?: unknown[] }).events ?? out;
    expect((list as unknown[]).length).toBeGreaterThan(0);
  });
});
