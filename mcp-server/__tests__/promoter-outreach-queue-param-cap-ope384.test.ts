import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPromoterOutreachQueueTool } from "../src/tools/admin-promoter-outreach-queue.js";

/**
 * OPE-384 stage 2 — D1 caps a statement at 100 BIND PARAMETERS.
 *
 * This test exists because the first cut of this tool shipped, deployed green,
 * and threw `D1_ERROR: too many SQL variables` on its very FIRST production
 * call. It read ~200 candidate ids and passed all of them into three
 * `inArray()` clauses.
 *
 * Every test passed. The whole 2,356-test MCP suite passed. Local SQLite allows
 * **32,766** bind parameters against D1's 100, so no amount of seeding in this
 * harness reproduces the failure by throwing — the statement simply succeeds.
 *
 * So the assertion cannot be "it does not throw". It has to be on the SHAPE of
 * the SQL: count the placeholders in every statement the tool issues and
 * require each to fit under D1's cap. That is the only form of this test that
 * fails on the machine where the bug is invisible.
 */
const D1_MAX_BIND_PARAMS = 100;

let db: TestDb;
let raw: { prepare: (sql: string) => unknown };
let statements: string[];

beforeEach(() => {
  const made = createTestDb();
  db = made.db;
  raw = made.raw as unknown as { prepare: (sql: string) => unknown };
  statements = [];

  // Record every statement the tool prepares. Wrapping `prepare` rather than
  // inspecting drizzle's builder catches the SQL that is actually sent.
  const originalPrepare = raw.prepare.bind(raw);
  raw.prepare = (sql: string) => {
    statements.push(sql);
    return originalPrepare(sql);
  };

  // `events.promoter_id` is NOT NULL, so a promoter has to exist first. It
  // carries no contact email on purpose — that is the majority real-world
  // shape (blocked on enrichment) and it keeps every seeded row in the queue.
  made.raw
    .prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p-1','Test Promoter','p-1')`)
    .run();

  // 150 candidate events — comfortably past the cap, and past the tool's own
  // 80-per-chunk size, so a regression to a single unchunked read is visible.
  for (let i = 0; i < 150; i++) {
    made.raw
      .prepare(
        `INSERT INTO events (id, slug, name, status, promoter_id, start_date, dates_confirmed, lifecycle_status)
         VALUES (?,?,?,'APPROVED','p-1',?,0,'SCHEDULED')`
      )
      .run(`ev-${i}`, `ev-${i}`, `Event ${i}`, Math.floor(Date.now() / 1000) + 86400 * 30);
  }
});

function countPlaceholders(sql: string): number {
  // `?` inside a string literal would over-count; none of these statements
  // contain string literals with question marks, and over-counting fails
  // safe (it can only make the assertion stricter).
  return (sql.match(/\?/g) ?? []).length;
}

describe("list_promoter_outreach_queue stays under D1's bind-parameter cap (OPE-384)", () => {
  it("issues no statement with more than 100 bind parameters", async () => {
    const server = new CapturingMcpServer();
    registerPromoterOutreachQueueTool(server as never, db, {
      userId: "u-admin",
      role: "ADMIN",
    } as never);

    await server.invoke("list_promoter_outreach_queue", { limit: 50 });

    // Guard the guard: if the tool stopped issuing parameterised reads, the
    // assertion below would pass over an empty list.
    const parameterised = statements.filter((s) => countPlaceholders(s) > 0);
    expect(parameterised.length).toBeGreaterThan(0);

    const worst = parameterised
      .map((sql) => ({ sql: sql.slice(0, 90), n: countPlaceholders(sql) }))
      .sort((a, b) => b.n - a.n)[0];

    expect(
      worst.n,
      `widest statement used ${worst.n} bind params (D1 allows ${D1_MAX_BIND_PARAMS}): ${worst.sql}`
    ).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
  });

  it("still returns a full page despite chunking the reads", async () => {
    // Chunking must not truncate the answer — a fix that stayed under the cap
    // by reading less would trade a crash for a silently short queue.
    const server = new CapturingMcpServer();
    registerPromoterOutreachQueueTool(server as never, db, {
      userId: "u-admin",
      role: "ADMIN",
    } as never);

    const res = (await server.invoke("list_promoter_outreach_queue", { limit: 50 })) as {
      content: Array<{ text: string }>;
    };
    const out = JSON.parse(res.content[0].text) as { total: number; scanned: number };
    expect(out.scanned).toBeGreaterThan(100);
    expect(out.total).toBe(50);
  });
});
