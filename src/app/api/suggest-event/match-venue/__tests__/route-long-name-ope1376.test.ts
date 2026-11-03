/**
 * OPE-1376 — the public match-venue route must not 500 on a long venue name.
 *
 * It built `like(venues.name, \`%${firstWord}%\`)` from unbounded request input,
 * and D1 rejects a LIKE pattern over 50 characters. The test db emulates that
 * cap (local SQLite allows 50,000), so the old shape is a red 500 here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "../../../../../../mcp-server/__tests__/setup-db";
import { venues } from "@/lib/db/schema";
import { emulateD1LikeCap } from "@/test/d1-like-cap";

let db: TestDb;
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
  rateLimitResponse: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

const { POST } = await import("../route");

const call = (body: unknown) =>
  POST(
    new NextRequest("https://meetmeatthefair.com/api/suggest-event/match-venue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  emulateD1LikeCap(t.raw);
  db.insert(venues)
    .values({
      id: "v1",
      name: "Fryeburg Fairgrounds",
      slug: unsafeSlug("fryeburg-fairgrounds"),
      address: "1154 Main St",
      zip: "04037",
      city: "Fryeburg",
      state: "ME",
    })
    .run();
});

describe("match-venue with long input", () => {
  it("a 200-character single-word name returns a clean no-match, not a 500 (with and without state)", async () => {
    const name = "F".repeat(200);
    for (const body of [{ venueName: name }, { venueName: name, venueState: "NH" }]) {
      const res = await call(body);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ success: true, matchFound: false });
    }
  });

  it("a name over the 200-char cap is a 400 at the schema, not a 500", async () => {
    const res = await call({ venueName: "F".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("a real name still matches (the filter is still a substring filter)", async () => {
    const res = await call({ venueName: "Fryeburg Fairgrounds" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { matchFound: boolean; bestMatch: { id: string } };
    expect(json.matchFound).toBe(true);
    expect(json.bestMatch.id).toBe("v1");
  });
});
