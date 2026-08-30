import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminVendorReadTools } from "../src/tools/admin-vendor-read.js";
import { vendors, users, entityClaims } from "../src/schema.js";

/**
 * OPE-649 — the tool that would have answered "did my edit save?" without D1.
 *
 * The fixture reproduces the 2026-08-30 support case exactly: a real signup who
 * claimed her own listing, saved a correction, and wrote in convinced the site
 * had eaten it. The one fact that settles it — `updated_at` LATER than
 * `created_at` — is the fact `get_vendor_details` does not return.
 */
function collect() {
  const tools = new Map<string, (a: never) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    tool: (n: string, _d: string, _s: unknown, cb: (a: never) => Promise<never>) =>
      void tools.set(n, cb as never),
  } as never;
  return { server, tools };
}

let db: TestDb;
let tools: ReturnType<typeof collect>["tools"];

async function call(args: unknown) {
  const res = await tools.get("get_vendor_details_admin")!(args as never);
  return JSON.parse(res.content[0].text);
}

const CREATED = new Date("2026-08-14T15:02:11Z");
const SAVED = new Date("2026-08-30T13:41:57Z"); // 18 minutes before she wrote in

beforeEach(async () => {
  ({ db } = createTestDb());
  const c = collect();
  registerAdminVendorReadTools(c.server, db as never, { role: "ADMIN", userId: "u" } as never);
  tools = c.tools;

  await db.insert(users).values([
    {
      id: "u-real",
      email: "hello@aehko.com",
      origin: "registration",
      role: "VENDOR",
      emailVerified: new Date("2026-08-14T15:09:40Z"),
      createdAt: CREATED,
      updatedAt: CREATED,
    },
    {
      id: "u-placeholder",
      email: "pending+harvested-crafts@meetmeatthefair.com",
      origin: "ingestion",
      role: "VENDOR",
      createdAt: CREATED,
      updatedAt: CREATED,
    },
    {
      // Shape says placeholder, column says registration — the disagreement
      // case placeholder-account.ts predicts and neither predicate can see alone.
      id: "u-disagree",
      email: "pending+stamp-was-forgotten@meetmeatthefair.com",
      origin: "registration",
      role: "VENDOR",
      createdAt: CREATED,
      updatedAt: CREATED,
    },
  ] as never);

  await db.insert(vendors).values([
    {
      id: "63f66866-5559-4f92-9ac9-3d6a7e489958",
      userId: "u-real",
      businessName: "Aehko",
      slug: "aehko",
      description: "Handmade goods.",
      claimed: true,
      claimedAt: new Date("2026-08-14T15:20:00Z"),
      claimedBy: "u-real",
      enrichmentSource: null,
      completenessScore: 88,
      address: "18 Main St",
      city: "Phillips",
      state: "ME",
      zip: "04966",
      socialLinks: '{"instagram":"https://instagram.com/aehko"}',
      createdAt: CREATED,
      updatedAt: SAVED,
    },
    {
      id: "v-harvested",
      userId: "u-placeholder",
      businessName: "Harvested Crafts",
      slug: "harvested-crafts",
      claimed: false,
      enrichmentSource: "mainefairs.net",
      createdAt: CREATED,
      updatedAt: CREATED,
    },
    {
      id: "v-disagree",
      userId: "u-disagree",
      businessName: "Stamp Was Forgotten",
      slug: "stamp-was-forgotten",
      createdAt: CREATED,
      updatedAt: CREATED,
    },
  ] as never);
});

describe("get_vendor_details_admin (OPE-649)", () => {
  it("proves a save landed — updated_at strictly after created_at", async () => {
    // THE diagnosis. Not "the row exists", not "the fields look right": the
    // question is whether HER WRITE reached the column, and only a stored
    // updated_at later than created_at can answer it. A reader that returned
    // the profile fields but not this timestamp would leave the honest answer
    // at "your page looks fine to me".
    const out = await call({ slug: "aehko" });
    expect(out.updated_at.epoch).toBeGreaterThan(out.created_at.epoch);
    expect(out.updated_at.iso).toBe("2026-08-30T13:41:57.000Z");
  });

  it("renders every timestamp as BOTH epoch seconds and ISO", async () => {
    // These columns are unix SECONDS. Comparing one to date('now') returns zero
    // rows with no error — a trap that has produced a false 'no affected rows'
    // finding on this project twice. The epoch must be ~1.7e9, NOT ~1.7e12:
    // a milliseconds value is the exact shape that silently mis-compares.
    const out = await call({ slug: "aehko" });
    expect(out.created_at.epoch).toBe(Math.floor(CREATED.getTime() / 1000));
    expect(String(out.created_at.epoch)).toHaveLength(10);
    expect(out.created_at.iso).toBe(CREATED.toISOString());
    expect(out.claimed_at.epoch).toBe(Math.floor(Date.parse("2026-08-14T15:20:00Z") / 1000));
    expect(String(out.claimed_at.epoch)).toHaveLength(10);
    // A null timestamp keeps the shape rather than collapsing to null, so a
    // caller never has to branch on it.
    expect(out.deleted_at).toEqual({ epoch: null, iso: null });
  });

  it("distinguishes a real owner from an ingestion placeholder", async () => {
    // vendors.user_id is NOT NULL, so 'has an owner' is true for every row and
    // proves nothing. ~98% of users are pending+<slug>@ synthetics.
    const real = await call({ slug: "aehko" });
    expect(real.owner_email).toBe("hello@aehko.com");
    expect(real.owner_is_placeholder.by_email_shape).toBe(false);
    expect(real.owner_is_placeholder.by_origin_column).toBe(false);
    expect(real.owner_is_placeholder.agree).toBe(true);

    const harvested = await call({ slug: "harvested-crafts" });
    expect(harvested.owner_is_placeholder.by_email_shape).toBe(true);
    expect(harvested.owner_is_placeholder.by_origin_column).toBe(true);
    expect(harvested.owner_is_placeholder.agree).toBe(true);
  });

  it("surfaces disagreement between the two placeholder predicates", async () => {
    // The case that justifies carrying both: a forgotten origin stamp. Either
    // predicate alone reports a confident, wrong answer here.
    const out = await call({ slug: "stamp-was-forgotten" });
    expect(out.owner_is_placeholder.by_email_shape).toBe(true);
    expect(out.owner_is_placeholder.by_origin_column).toBe(false);
    expect(out.owner_is_placeholder.agree).toBe(false);
  });

  it("returns address, zip and social_links — which update_vendor writes and the public reader hides", async () => {
    // OPE-534's shape: a writer that can destroy a field no reader can show.
    const out = await call({ slug: "aehko" });
    expect(out.address).toBe("18 Main St");
    expect(out.zip).toBe("04966");
    expect(out.social_links).toBe('{"instagram":"https://instagram.com/aehko"}');
  });

  it("reports claimed=true even with zero entity_claims rows (OPE-236)", async () => {
    // The live claim path writes vendors.claimed ONLY. A caller who read the
    // claims table alone would conclude this vendor is unclaimed.
    const out = await call({ slug: "aehko" });
    expect(out.claimed).toBe(true);
    expect(out.claimed_by).toBe("u-real");
    expect(out.entity_claims_rows).toBe(0);
  });

  it("counts entity_claims rows when they DO exist", async () => {
    await db.insert(entityClaims).values({
      id: "c1",
      entityType: "VENDOR",
      entityId: "63f66866-5559-4f92-9ac9-3d6a7e489958",
      userId: "u-real",
      method: "EMAIL_MATCH",
      status: "APPROVED",
      createdAt: CREATED,
    } as never);
    const out = await call({ slug: "aehko" });
    expect(out.entity_claims_rows).toBe(1);
    expect(out.entity_claims_latest_status).toBe("APPROVED");
  });

  it("does not count another entity's claims as this vendor's", async () => {
    // The claims table is polymorphic with NO foreign key, so an id collision
    // across entity types is a live possibility, not a hypothetical.
    await db.insert(entityClaims).values({
      id: "c2",
      entityType: "PROMOTER",
      entityId: "63f66866-5559-4f92-9ac9-3d6a7e489958",
      userId: "u-real",
      method: "ADMIN",
      status: "APPROVED",
      createdAt: CREATED,
    } as never);
    const out = await call({ slug: "aehko" });
    expect(out.entity_claims_rows).toBe(0);
  });

  it("accepts a UUID as well as a slug", async () => {
    const bySlug = await call({ slug: "aehko" });
    const byId = await call({ vendor_id: "63f66866-5559-4f92-9ac9-3d6a7e489958" });
    expect(byId.id).toBe(bySlug.id);
    expect(byId.updated_at.epoch).toBe(bySlug.updated_at.epoch);
  });

  it("errors rather than returning an arbitrary row when given neither key", async () => {
    const res = await tools.get("get_vendor_details_admin")!({} as never);
    expect(JSON.parse(res.content[0].text).error).toBe("slug_or_vendor_id_required");
  });

  it("is not registered at all for a non-admin", async () => {
    // Registrar-level gating: a non-admin does not get 'permission denied',
    // the tool is simply absent from their tool list. There is no code path
    // by which their request reaches the handler.
    const c = collect();
    registerAdminVendorReadTools(c.server, db as never, { role: "VENDOR", userId: "u" } as never);
    expect(c.tools.has("get_vendor_details_admin")).toBe(false);
  });
});
