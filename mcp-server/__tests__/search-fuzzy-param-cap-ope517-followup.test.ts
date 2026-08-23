/**
 * OPE-517 followup — the variants lookup I added to the fuzzy path was not
 * chunked, and broke fuzzy search in prod the same day it shipped.
 *
 * `search_events` over-fetches on the fuzzy path (`Math.max(limit * 10, 200)`)
 * because scoring reorders rows in JS. OPE-517 then fetched name variants for
 * the candidate rows with a single `inArray(eventNameVariants.eventId, ids)` —
 * so once the over-fetch filled past ~90 rows the statement bound more than
 * D1's 100-parameter ceiling and threw:
 *
 *   D1_ERROR: too many SQL variables at offset 399: SQLITE_ERROR
 *
 * It fires on exactly the queries fuzzy exists to serve: the token pre-filter
 * is an OR, so a common word ("fair", "festival") matches hundreds of rows.
 * Reported from a three-word query, "Winthrop Arts Festival".
 *
 * The remedy already existed — chunkIds (OPE-241), whose docblock example is
 * this exact query shape.
 *
 * ⚠️ Why this test inspects SQL instead of just calling the tool.
 *
 * The obvious test — "150 rows, call fuzzy search, expect no throw" — PASSES
 * WITHOUT THE FIX. The suite runs better-sqlite3, whose bind-param ceiling is
 * 32766, not D1's 100, so the failing statement executes happily in-process.
 * Verified by reverting the chunking: 4/4 still green. That is the same trap as
 * the D1 LIKE-pattern cap, where local sqlite allows 50000 and no unit test
 * could ever catch it.
 *
 * So the behavioural cases below are kept only as a smoke check, and the real
 * guard asserts the STRUCTURAL property that survives the engine difference:
 * no single statement touching event_name_variants may bind more parameters
 * than D1 will accept.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import type Database from "better-sqlite3";
import { registerPublicTools } from "../src/tools/public.js";
import { events, promoters } from "../src/schema.js";
import { D1_MAX_BIND_PARAMS } from "@takemetothefair/utils";

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;
/** Every SQL statement prepared during a test, in order. */
let prepared: string[];

/** Comfortably past the ceiling, so the failure is structural, not marginal. */
const ROWS = 150;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  prepared = [];
  const originalPrepare = raw.prepare.bind(raw);
  // Record every statement so we can measure the one that binds the id list.
  (raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    prepared.push(sql);
    return originalPrepare(sql);
  };
  server = new CapturingMcpServer();
  registerPublicTools(server as never, db);
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p" }).run();

  const future = new Date(Date.now() + 30 * 86400_000);
  for (let i = 0; i < ROWS; i++) {
    db.insert(events)
      .values({
        // Every row shares the common token, which is what makes the OR
        // pre-filter match all of them and fill the over-fetch.
        id: `9a395062-0000-4000-8000-${String(i).padStart(12, "0")}`,
        name: `Harborside Festival Number ${i}`,
        slug: `harborside-festival-number-${i}`,
        promoterId: "p-1",
        status: "APPROVED",
        startDate: future,
        endDate: future,
      })
      .run();
  }
});

const parse = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

/**
 * The variants LOOKUP statements only.
 *
 * Filtering on `includes("event_name_variants")` is not enough and silently
 * makes these assertions vacuous: `nameOrVariantLike` puts an
 * `EXISTS (SELECT 1 FROM event_name_variants …)` inside the main search query,
 * so that statement matches too and the count is >1 even when the lookup is
 * unchunked. Match the lookup's own SELECT list instead.
 */
const lookupStatements = () =>
  prepared.filter((s) =>
    /^select\s+"event_id",\s*"variant"\s+from\s+"event_name_variants"/i.test(s)
  );

describe("fuzzy search over a candidate set larger than D1's bind-param cap", () => {
  it("the fixture really does exceed the ceiling — otherwise this test proves nothing", () => {
    expect(ROWS).toBeGreaterThan(D1_MAX_BIND_PARAMS);
  });

  it("does not throw when the over-fetch exceeds the parameter ceiling", async () => {
    const out = parse(
      await server.invoke("search_events", { query: "Harborside Festival", fuzzy: true })
    );
    const list = (out as { events?: unknown[] }).events ?? out;
    expect(Array.isArray(list)).toBe(true);
    expect((list as unknown[]).length).toBeGreaterThan(0);
  });

  it("still returns matches rather than swallowing the error into an empty list", async () => {
    // A silent empty array would satisfy "does not throw" while being just as
    // broken, so assert we got real rows back.
    const out = parse(
      await server.invoke("search_events", { query: "Harborside Festival", fuzzy: true })
    );
    const list = ((out as { events?: Array<{ slug: string }> }).events ?? out) as Array<{
      slug: string;
    }>;
    expect(list.every((e) => e.slug.startsWith("harborside-festival-number-"))).toBe(true);
  });

  it("the non-fuzzy path over the same corpus is unaffected (control)", async () => {
    const out = parse(await server.invoke("search_events", { query: "Harborside Festival" }));
    const list = ((out as { events?: unknown[] }).events ?? out) as unknown[];
    expect(list.length).toBeGreaterThan(0);
  });
});

describe("the structural guard — statement shape, not engine behaviour", () => {
  it("no statement touching event_name_variants binds more params than D1 accepts", async () => {
    await server.invoke("search_events", { query: "Harborside Festival", fuzzy: true });

    const stmts = lookupStatements();
    expect(stmts.length).toBeGreaterThan(0); // the lookup ran at all

    for (const stmt of stmts) {
      const placeholders = (stmt.match(/\?/g) ?? []).length;
      expect(placeholders, stmt.slice(0, 120)).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });

  it("splits the lookup into more than one statement once past a chunk", async () => {
    // 150 candidate rows at a 90-row chunk = 2 statements. Unchunked it is 1,
    // which is precisely the shipped bug — so this assertion is what actually
    // fails when the fix is reverted.
    await server.invoke("search_events", { query: "Harborside Festival", fuzzy: true });

    expect(lookupStatements().length).toBeGreaterThan(1);
  });
});
