/**
 * OPE-1090 — `create_vendor` and `update_vendor` must take the SAME names for
 * the same columns, and a create must report what actually landed.
 *
 * The defect: the two tools wrote the same columns under different parameter
 * names (`location` vs `city`+`state`, `type` vs `vendor_type`), and
 * `contact_name` / `social_links` could not be set at create time at all. Zod's
 * default object behaviour STRIPS unknown keys before the handler runs, so a
 * caller who used the sibling tool's vocabulary — the obvious thing to do — got
 * `created: true` and a row with five NULLs.
 *
 * `city`/`state` is the by-state browse filter, so that row was invisible to
 * every by-state browse page while the call reported success.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { vendors } from "../src/schema.js";
import { eq } from "drizzle-orm";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db as never, ADMIN_AUTH);
});

/** The row as stored, which is the only thing that settles this. */
function stored(name: string) {
  return db.select().from(vendors).where(eq(vendors.businessName, name)).all()[0];
}

/** Parse the tool's JSON response body. */
function body(res: { content: { text?: string }[] }) {
  return JSON.parse(res.content[0].text ?? "{}");
}

describe("OPE-1090 — update_vendor's vocabulary works on create_vendor", () => {
  it("ACCEPTANCE: one call populates city, state, vendor_type, contact_name and social_links", async () => {
    const res = await server.invoke("create_vendor", {
      business_name: "Shannon's Kustom Shoes and Shirts",
      city: "Portland",
      state: "ME",
      vendor_type: "Crafts",
      contact_name: "Shannon",
      social_links: '{"facebook":"https://facebook.com/shannons"}',
    });

    const row = stored("Shannon's Kustom Shoes and Shirts");
    expect(row.city).toBe("Portland");
    expect(row.state).toBe("ME");
    expect(row.vendorType).toBe("Crafts");
    expect(row.contactName).toBe("Shannon");
    expect(row.socialLinks).toBe('{"facebook":"https://facebook.com/shannons"}');

    // …and the caller is told so, rather than just `created: true`.
    expect(body(res).stored).toEqual({
      city: "Portland",
      state: "ME",
      vendor_type: "Crafts",
      contact_name: "Shannon",
      social_links: '{"facebook":"https://facebook.com/shannons"}',
    });
  });

  it("no warning when nothing was aliased and state landed", async () => {
    const res = await server.invoke("create_vendor", {
      business_name: "Clean Call Co",
      city: "Augusta",
      state: "ME",
    });
    expect(body(res).warnings).toBeUndefined();
  });
});

describe("OPE-1090 — the legacy vocabulary still works, and says it is legacy", () => {
  it("`location` and `type` still write the same columns — existing callers are not broken", async () => {
    const res = await server.invoke("create_vendor", {
      business_name: "Artisan Hill Treats",
      type: "Food & Beverage",
      location: "Dublin, NH",
    });

    const row = stored("Artisan Hill Treats");
    expect(row.city).toBe("Dublin");
    expect(row.state).toBe("NH");
    expect(row.vendorType).toBe("Food & Beverage");

    expect(body(res).warnings.deprecated_params).toEqual([
      "location → city + state",
      "type → vendor_type",
    ]);
  });

  it("the canonical name WINS when both are sent", async () => {
    await server.invoke("create_vendor", {
      business_name: "Both Names Co",
      location: "Dublin, NH",
      city: "Portland",
      state: "ME",
      type: "Food",
      vendor_type: "Crafts",
    });

    const row = stored("Both Names Co");
    expect(row.city).toBe("Portland");
    expect(row.state).toBe("ME");
    expect(row.vendorType).toBe("Crafts");
  });
});

describe("OPE-1090 — the by-state browse trap is named", () => {
  it("a `location` with NO comma sets city and leaves state NULL — and now warns", async () => {
    // 135 vendors in prod carry exactly this signature: a city and no state.
    // `parseLocation` splits on the last comma; with none, the whole string is
    // the city. The row is then absent from every by-state browse page.
    const res = await server.invoke("create_vendor", {
      business_name: "No Comma Crafts",
      location: "Portland",
    });

    const row = stored("No Comma Crafts");
    expect(row.city).toBe("Portland");
    expect(row.state).toBeNull();

    expect(body(res).warnings.no_state).toContain("by-state browse");
  });

  it("warns when no location information was given at all", async () => {
    const res = await server.invoke("create_vendor", { business_name: "Nowhere Co" });
    expect(stored("Nowhere Co").state).toBeNull();
    expect(body(res).warnings.no_state).toContain("by-state browse");
  });
});
