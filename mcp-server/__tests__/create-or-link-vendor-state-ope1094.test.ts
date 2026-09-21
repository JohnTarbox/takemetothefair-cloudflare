/**
 * OPE-1094 — `create_or_link_vendor` must be able to express `state` directly.
 *
 * `state` is what every by-state browse page filters on, and this writer could
 * only reach it through `location`, a single "City, ST" string split on its
 * LAST comma. A value with no comma sets `city` and leaves `state` NULL without
 * a word. Measured in prod: this tool created **4,637 of the 5,626** stateless
 * vendors (82%), every one absent from those pages, every call reporting
 * success. Only **92** of them even have a city.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters, vendors } from "../src/schema.js";

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
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: "test-promoter" })
    .run();
  db.insert(events)
    .values({
      id: "event-1",
      name: "Test Event",
      slug: "test-event",
      promoterId: "promoter-1",
      status: "APPROVED",
    })
    .run();
});

afterEach(() => mock.restore());

/** The stored row — the only thing that settles this. */
const stored = (name: string) =>
  db.select().from(vendors).where(eq(vendors.businessName, name)).all()[0];

const body = (res: { content: { text?: string }[] }) => JSON.parse(res.content[0].text ?? "{}");

const call = (args: Record<string, unknown>) =>
  server.invoke("create_or_link_vendor", {
    event_id: "event-1",
    dedup_strategy: "strict",
    ...args,
  }) as Promise<{ content: { text?: string }[] }>;

describe("OPE-1094 — canonical city/state on create", () => {
  it("ACCEPTANCE: one call sets city and state, proven by the stored row", async () => {
    const res = await call({ business_name: "Statey Crafts", city: "Portland", state: "ME" });

    const row = stored("Statey Crafts");
    expect(row.city).toBe("Portland");
    expect(row.state).toBe("ME");

    // …and the response says what landed, which it could not before.
    expect(body(res).stored).toEqual({ city: "Portland", state: "ME" });
    expect(body(res).warnings).toBeUndefined();
  });

  it("canonical WINS over the `location` alias when both are sent", async () => {
    await call({
      business_name: "Both Names Co",
      location: "Dublin, NH",
      city: "Portland",
      state: "ME",
    });

    const row = stored("Both Names Co");
    expect(row.city).toBe("Portland");
    expect(row.state).toBe("ME");
  });
});

describe("OPE-1094 — existing callers are not broken", () => {
  it("`location` still populates both columns", async () => {
    const res = await call({ business_name: "Legacy Vocab Co", location: "Dublin, NH" });

    const row = stored("Legacy Vocab Co");
    expect(row.city).toBe("Dublin");
    expect(row.state).toBe("NH");
    expect(body(res).warnings.deprecated_params).toEqual(["location → city + state"]);
  });
});

describe("OPE-1094 — the browse-invisible create is named at the call site", () => {
  it("a `location` with NO comma sets city, leaves state NULL, and now warns", async () => {
    // 92 rows in prod carry exactly this signature.
    const res = await call({ business_name: "No Comma Crafts", location: "Portland" });

    const row = stored("No Comma Crafts");
    expect(row.city).toBe("Portland");
    expect(row.state).toBeNull();
    expect(body(res).warnings.no_state).toContain("by-state browse");
  });

  it("no location information at all also warns — the 4,545-row shape", async () => {
    const res = await call({ business_name: "Nowhere Co" });

    expect(stored("Nowhere Co").state).toBeNull();
    expect(body(res).warnings.no_state).toContain("by-state browse");
  });

  it("scope 3: a MATCH does not touch the existing row's location, and does not warn about it", async () => {
    // The vendor already exists with a state. Linking must not overwrite it —
    // OPE-714 settled that a link call may not clobber a curated field just by
    // mentioning a vendor — and must not emit a `no_state` warning, because
    // nothing was created and nothing is missing.
    await call({ business_name: "Existing Co", city: "Bangor", state: "ME" });
    const before = stored("Existing Co");

    const res = await call({
      business_name: "Existing Co",
      city: "Portland",
      state: "NH",
      event_id: "event-1",
    });

    const after = stored("Existing Co");
    expect(after.id).toBe(before.id); // matched, not re-created
    expect(after.city).toBe("Bangor");
    expect(after.state).toBe("ME");
    expect(body(res).was_created).toBe(false);
    expect(body(res).warnings?.no_state).toBeUndefined();
    expect(body(res).stored).toBeUndefined();
  });
});
