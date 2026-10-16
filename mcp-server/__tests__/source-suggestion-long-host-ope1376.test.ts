/**
 * OPE-1376 — the source_suggestion handler's tier-2 lookup must not throw on a
 * long host. The host is taken from the SENDER's email, and the old
 * `like(events.sourceUrl, \`%${host}%\`)` crossed D1's 50-char LIKE-pattern cap
 * for any host of ~49+ characters. The test db emulates that cap (local SQLite
 * allows 50,000), so the old shape is red here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "./setup-db";
import { emulateD1LikeCap } from "../../src/test/d1-like-cap";
import { events, promoters } from "../src/schema.js";

const harness: { db: TestDb } = { db: null as unknown as TestDb };
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));

const { handle } = await import("../src/email-handlers/source-suggestion.js");

let raw: ReturnType<typeof createTestDb>["raw"];

beforeEach(() => {
  const t = createTestDb();
  harness.db = t.db;
  raw = t.raw;
  emulateD1LikeCap(raw);
  harness.db
    .insert(promoters)
    .values({ id: "p1", companyName: "P", slug: unsafeSlug("p") })
    .run();
  harness.db
    .insert(events)
    .values({
      id: "e1",
      name: "Fryeburg Fair",
      slug: unsafeSlug("fryeburg-fair-2026"),
      promoterId: "p1",
      sourceUrl: "https://fryeburgfair.org/schedule",
    })
    .run();
});

const row = (url: string) =>
  ({
    id: "in-1",
    fromAddress: "someone@example.com",
    subject: "a source for you",
    parsedUrl: url,
    bodyTextExcerpt: url,
  }) as never;

describe("source_suggestion tier 2", () => {
  it("a 60+ character host reaches tier 3 instead of throwing", async () => {
    const host = `${"a".repeat(30)}.${"b".repeat(30)}.example.org`;
    expect(host.length).toBeGreaterThan(60);
    const out = await handle({} as never, {} as never, row(`https://${host}/events`));
    expect(out.replyParams).toMatchObject({ suggestedHost: host, tier: "new" });
    const n = raw.prepare("SELECT COUNT(*) AS n FROM email_source_suggestions").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });

  it("a host we already source from informally is still found (substring match kept)", async () => {
    const out = await handle({} as never, {} as never, row("https://www.FryeburgFair.org/"));
    expect(out.replyParams).toMatchObject({
      suggestedHost: "fryeburgfair.org",
      tier: "informal",
      informalUsageCount: 1,
    });
  });
});
