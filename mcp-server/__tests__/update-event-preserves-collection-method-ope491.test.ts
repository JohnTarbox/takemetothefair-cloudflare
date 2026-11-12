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

describe("update_event source edits (OPE-491 → OPE-1642 write-once)", () => {
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

  // OPE-1642 — write-once. The positive landmark is source_domain, which DOES
  // refresh (so the reclassify block ran), beside the method that did not move.
  const call = async (args: Record<string, unknown>) => {
    const res = (await server.invoke("update_event", args)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError, res.content?.[0]?.text).toBeFalsy();
    return JSON.parse(res.content[0].text) as Record<string, any>;
  };

  it("source_name='facebook' on a web_research row keeps web_research, and reports the derived domain (the 3b7ddadb specimen)", async () => {
    seed("e2", {
      ingestionMethod: "web_research",
      sourceName: "daily-discovery",
      sourceUrl: "https://vacationlandent.org/pine-state-expo",
      sourceDomain: "vacationlandent.org",
    });
    const body = await call({
      event_id: "e2",
      source_url: "https://www.facebook.com/pinestateexpo/",
      source_name: "facebook",
    });
    expect(row("e2")).toEqual({ m: "web_research", d: "facebook.com" });
    expect(body.derivedFieldsUpdated).toEqual(["source_domain"]);
    expect(body.previousValues.source_domain).toBe("vacationlandent.org");
    expect(body.newValues.source_domain).toBe("facebook.com");
    expect(body.previousValues).not.toHaveProperty("ingestion_method");
  });

  it("a domain-derived value is kept too (admin_manual stays admin_manual)", async () => {
    seed("e3", { ingestionMethod: "admin_manual", sourceName: "St. John Valley Chamber" });
    await call({ event_id: "e3", source_url: "https://organizer.example/fair" });
    expect(row("e3")).toEqual({ m: "admin_manual", d: "organizer.example" });
  });

  it("a NULL method is filled from the new source and reported as derived", async () => {
    seed("e4", { ingestionMethod: null, sourceName: null });
    const body = await call({ event_id: "e4", source_url: "https://organizer.example/fair" });
    expect(row("e4")).toEqual({ m: "direct_scrape", d: "organizer.example" });
    expect(body.derivedFieldsUpdated).toEqual(["source_domain", "ingestion_method"]);
    expect(body.previousValues.ingestion_method).toBeNull();
  });

  it("an explicit ingestion_method reclassifies deliberately, reported like any field (and repairs the specimen)", async () => {
    seed("e5", {
      ingestionMethod: "discovery",
      sourceName: "daily-discovery",
      sourceDomain: "facebook.com",
    });
    const body = await call({ event_id: "e5", ingestion_method: "web_research" });
    expect(row("e5").m).toBe("web_research");
    expect(body.fieldsUpdated).toContain("ingestion_method");
    expect(body.previousValues.ingestion_method).toBe("discovery");
    expect(body.newValues.ingestion_method).toBe("web_research");
    // An explicit value alongside a source edit is what is written.
    const both = await call({
      event_id: "e5",
      source_url: "https://x.example/",
      source_name: "facebook",
      ingestion_method: "email_submission",
    });
    expect(row("e5")).toEqual({ m: "email_submission", d: "x.example" });
    expect(both.derivedFieldsUpdated).toEqual(["source_domain"]);
  });

  it("refuses an ingestion_method outside the allow-list", async () => {
    seed("e6", { ingestionMethod: "web_research" });
    const res = (await server.invoke("update_event", {
      event_id: "e6",
      ingestion_method: "made_up",
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(row("e6").m).toBe("web_research");
  });
});
