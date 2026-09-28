/**
 * OPE-1183 — merge_venue records a redirect for BOTH the duplicate's original
 * slug and its parked tombstone slug, so neither URL 404s.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerMergeEntitiesTools } from "../src/tools/admin-merge-entities.js";
import { venueSlugHistory, venues } from "../src/schema.js";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerMergeEntitiesTools(server as never, db, { userId: "u-admin", role: "ADMIN" } as never);
  mock = mockIndexNowFetch();
  for (const [id, slug] of [
    ["keeper", "champlain-valley-exposition"],
    ["dup", "champlain-valley-fair"],
  ])
    db.insert(venues)
      .values({
        id,
        name: slug,
        slug: unsafeSlug(slug),
        address: "1 Main",
        city: "Essex Junction",
        state: "VT",
        zip: "05452",
      })
      .run();
});
afterEach(() => mock.restore());

describe("merge_venue (OPE-1183)", () => {
  it("writes original -> keeper AND tombstone -> keeper", async () => {
    const r = (await server.invoke("merge_venue", {
      keeper_venue_id: "keeper",
      duplicate_venue_id: "dup",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBeFalsy();
    const [dup] = db.select().from(venues).where(eq(venues.id, "dup")).all();
    expect(dup.status).toBe("INACTIVE");
    const rows = db
      .select({ oldSlug: venueSlugHistory.oldSlug, newSlug: venueSlugHistory.newSlug })
      .from(venueSlugHistory)
      .all()
      .map((x) => `${x.oldSlug} -> ${x.newSlug}`)
      .sort();
    expect(rows).toEqual(
      [
        "champlain-valley-fair -> champlain-valley-exposition",
        `${dup.slug} -> champlain-valley-exposition`,
      ].sort()
    );
    expect(dup.slug).toMatch(/^champlain-valley-fair-merged-/);
  });
});
