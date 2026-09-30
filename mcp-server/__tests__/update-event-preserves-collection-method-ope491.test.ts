/**
 * OPE-491 rework — through the real `update_event` tool: adding a citation URL
 * refreshes source_domain but does not rewrite ingestion_method.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters } from "../src/schema.js";
import { eq } from "drizzle-orm";

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
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
});
afterEach(() => mock.restore());

function seed(id: string, over: Record<string, unknown>) {
  db.insert(events)
    .values({
      id,
      name: `Fair ${id}`,
      slug: `fair-${id}`,
      promoterId: "p1",
      status: "PENDING",
      ...over,
    } as never)
    .run();
}
const row = (id: string) =>
  db
    .select({ m: events.ingestionMethod, d: events.sourceDomain })
    .from(events)
    .where(eq(events.id, id))
    .get()!;

describe("update_event source edits (OPE-491)", () => {
  it("keeps email_submission when a repair sets source_url + source_name (the 13f7f7a4 shape)", async () => {
    seed("e1", {
      ingestionMethod: "email_submission",
      suggesterEmail: "organizer@example.org",
      sourceName: "email-submission",
    });
    const res = (await server.invoke("update_event", {
      event_id: "e1",
      source_url: "https://www.facebook.com/revolutionaryfair",
      source_name: "Revolutionary Fair Facebook page",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError, res.content?.[0]?.text).toBeFalsy();
    expect(row("e1")).toEqual({ m: "email_submission", d: "facebook.com" });
  });

  it("still re-derives a domain-derived row (positive landmark: the recompute path runs)", async () => {
    seed("e2", { ingestionMethod: "admin_manual", sourceName: "St. John Valley Chamber" });
    await server.invoke("update_event", {
      event_id: "e2",
      source_url: "https://organizer.example/fair",
    });
    expect(row("e2")).toEqual({ m: "direct_scrape", d: "organizer.example" });
  });
});
