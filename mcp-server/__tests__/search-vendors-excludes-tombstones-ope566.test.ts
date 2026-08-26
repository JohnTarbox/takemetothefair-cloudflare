/**
 * OPE-566 — `search_vendors` returned merge tombstones as if they were live.
 *
 * `merge_vendor` soft-deletes the loser and renames its slug to
 * `<orig>-merged-<id8>`, exactly as `merge_events` does. `search_vendors` had
 * **no base filter at all**, so every one of the 116 soft-deleted rows in prod
 * came back looking like a real vendor. Reproduced live before the fix:
 *
 *     search_vendors("Sea Bags") → 2 results
 *       sea-bags                        ← the keeper,  /vendors/sea-bags → 200
 *       sea-bags-llc-merged-b653a2cc    ← a tombstone, its page → 301
 *
 * This is OPE-432's finding one entity type over: returning a tombstone hands
 * the caller a URL that redirects away. Worse here than a bad link, because a
 * caller picking a vendor from search can carry that id into a write.
 *
 * (The vendor-LINKING path was already safe — `packages/vendor-linking` filters
 * `isNull(vendors.deletedAt)` on both its exact and fuzzy matchers. The leak was
 * search only, which is why the fix is here and not there.)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPublicTools } from "../src/tools/public.js";
import { vendors, users } from "../src/schema.js";
import { unsafeSlug } from "@takemetothefair/utils";

let db: TestDb;
let server: CapturingMcpServer;

const KEEPER = "11111111-0000-4000-8000-000000000001";
const TOMBSTONE = "22222222-0000-4000-8000-000000000002";

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

function seedVendor(id: string, businessName: string, slug: string, deletedAt: Date | null) {
  db.insert(users)
    .values({ id: `u-${id}`, email: `${id}@example.com`, role: "VENDOR" })
    .run();
  db.insert(vendors)
    .values({
      id,
      userId: `u-${id}`,
      businessName,
      slug: unsafeSlug(slug),
      vendorType: "Giftware",
      deletedAt,
    } as never)
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerPublicTools(server as never, db);

  seedVendor(KEEPER, "Sea Bags", "sea-bags", null);
  seedVendor(TOMBSTONE, "Sea Bags, LLC", "sea-bags-llc-merged-b653a2cc", new Date("2026-08-21"));
});

describe("search_vendors excludes merge tombstones (OPE-566)", () => {
  it("returns the keeper and NOT the soft-deleted row — the live repro", async () => {
    const out = parse(await server.invoke("search_vendors", { query: "Sea Bags" }));

    expect(out.count).toBe(1);
    expect(out.vendors[0].slug).toBe("sea-bags");
    expect(out.vendors.map((v: { id: string }) => v.id)).not.toContain(TOMBSTONE);
  });

  it("never returns a `-merged-` slug, which is the visible tell", async () => {
    const out = parse(await server.invoke("search_vendors", {}));
    for (const v of out.vendors) expect(v.slug).not.toMatch(/-merged-/);
  });

  it("still finds live vendors when the query matches nothing deleted", async () => {
    // The exclusion must not cost recall on ordinary searches.
    const out = parse(await server.invoke("search_vendors", { query: "Sea" }));
    expect(out.count).toBe(1);
    expect(out.vendors[0].businessName).toBe("Sea Bags");
  });
});

describe("the escape hatch — auditing a merge is a real need (OPE-566)", () => {
  it("include_deleted surfaces the tombstone", async () => {
    // A silent exclusion with no way to look is how the next investigation gets
    // stuck. Mirrors search_performers, which already works this way.
    const out = parse(
      await server.invoke("search_vendors", { query: "Sea Bags", include_deleted: true })
    );

    expect(out.count).toBe(2);
    expect(out.vendors.map((v: { id: string }) => v.id)).toContain(TOMBSTONE);
  });

  it("defaults to excluding when the flag is absent or false", async () => {
    for (const args of [{ query: "Sea Bags" }, { query: "Sea Bags", include_deleted: false }]) {
      const out = parse(await server.invoke("search_vendors", args));
      expect(out.count).toBe(1);
    }
  });
});
