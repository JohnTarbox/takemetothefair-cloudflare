/**
 * OPE-1223 — create_or_link_vendor("Kim Ferreira ~ Joie De Vivre", strict)
 * 500'd with a raw `insert into "users"` error. The merge tombstone "Kim
 * Ferreira - Joie de Vivre" (slug renamed to …-merged-9f11bd96, so the slug was
 * free) still held the owner address pending+kim-ferreira-joie-de-vivre@, and
 * strict dedup never looked at tombstones, so it took the create path.
 * Through the real tool against SQLite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freePlaceholderEmail } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventVendors, events, promoters, users, vendors } from "../src/schema.js";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;
const TOMB_EMAIL = "pending+kim-ferreira-joie-de-vivre@meetmeatthefair.com";

function seed(withRedirect: boolean) {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(
    server as never,
    db,
    { userId: "u-admin", role: "ADMIN" } as never,
    {
      MAIN_APP_URL: "https://meetmeatthefair.com",
      INTERNAL_API_KEY: "k",
    } as never
  );
  db.insert(promoters)
    .values({ id: "p1", companyName: "P", slug: "p" } as never)
    .run();
  db.insert(events)
    .values({
      id: "freeport",
      name: "Freeport Fall Festival 2026",
      slug: "freeport",
      promoterId: "p1",
      status: "APPROVED",
    } as never)
    .run();
  db.insert(users)
    .values([
      { id: "u-keep", email: "pending+kim-ferreira@meetmeatthefair.com", role: "VENDOR" },
      { id: "u-tomb", email: TOMB_EMAIL, role: "VENDOR" },
    ] as never)
    .run();
  db.insert(vendors)
    .values([
      { id: "ba57832f", userId: "u-keep", businessName: "Kim Ferreira", slug: "kim-ferreira" },
      {
        id: "9f11bd96",
        userId: "u-tomb",
        businessName: "Kim Ferreira - Joie de Vivre",
        slug: "kim-ferreira-joie-de-vivre-merged-9f11bd96",
        deletedAt: new Date("2026-08-20T00:00:00Z"),
        redirectToVendorId: withRedirect ? "ba57832f" : null,
      },
    ] as never)
    .run();
}

const call = () =>
  server.invoke("create_or_link_vendor", {
    event_id: "freeport",
    business_name: "Kim Ferreira ~ Joie De Vivre",
    dedup_strategy: "strict",
    booth_info: "Booth 121",
  }) as Promise<{ isError?: boolean; content: { text?: string }[] }>;

beforeEach(() => {
  mock = mockIndexNowFetch();
});
afterEach(() => mock.restore());

describe("OPE-1223 — the specimen", () => {
  it("a strict match on a merged-away tombstone links its KEEPER, creating nothing", async () => {
    seed(true);
    const res = await call();
    expect(res.isError).toBeFalsy();
    const links = db.select().from(eventVendors).where(eq(eventVendors.eventId, "freeport")).all();
    expect(links.map((l) => l.vendorId)).toEqual(["ba57832f"]);
    expect(db.select().from(vendors).all()).toHaveLength(2); // no new vendor
  });

  it("a plain-deleted namesake (no keeper) creates a vendor on a FREE owner address — no raw SQL error", async () => {
    seed(false);
    const res = await call();
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text ?? "").not.toMatch(/Failed query|insert into/i);
    const created = db
      .select()
      .from(vendors)
      .where(eq(vendors.businessName, "Kim Ferreira ~ Joie De Vivre"))
      .all()[0];
    expect(created).toBeTruthy();
    // The slug was free, so the vendor keeps it; only the owner address moves.
    expect(created.slug).toBe("kim-ferreira-joie-de-vivre");
    const owner = db.select().from(users).where(eq(users.id, created.userId)).all()[0];
    expect(owner.email).toBe("pending+kim-ferreira-joie-de-vivre-2@meetmeatthefair.com");
  });
});

describe("freePlaceholderEmail", () => {
  it("returns the plain address when free, the next suffix when taken", async () => {
    const taken = new Set([TOMB_EMAIL]);
    expect(
      await freePlaceholderEmail("pending+", "kim-ferreira-joie-de-vivre", async (e) =>
        taken.has(e)
      )
    ).toBe("pending+kim-ferreira-joie-de-vivre-2@meetmeatthefair.com");
    expect(await freePlaceholderEmail("pending+", "brand-new", async () => false)).toBe(
      "pending+brand-new@meetmeatthefair.com"
    );
  });
  it("throws a clear error rather than looping forever", async () => {
    await expect(freePlaceholderEmail("pending+", "x", async () => true, 3)).rejects.toThrow(
      /no free placeholder/
    );
  });
});
