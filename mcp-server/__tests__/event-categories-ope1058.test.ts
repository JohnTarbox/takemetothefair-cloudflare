/**
 * OPE-1058 — the two writers now share one allow-list, with opposite policies.
 *
 * The defect: `suggest_event` filtered against EVENT_CATEGORIES while
 * `update_event` took `z.array(z.string())`. On 2026-09-17 the Alexander
 * Hamfest was created through `suggest_event`, which correctly dropped
 * "Amateur Radio Convention" — and two minutes later `update_event` stored the
 * same string unchecked. One value, refused and accepted by the same system.
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
  db.insert(events)
    .values({
      id: "e1",
      name: "Alexander Hamfest",
      slug: "alexander-hamfest",
      promoterId: "p1",
      status: "PENDING",
      categories: JSON.stringify(["Event"]),
    } as never)
    .run();
});
afterEach(() => mock.restore());

const stored = () =>
  JSON.parse(
    db.select({ c: events.categories }).from(events).where(eq(events.id, "e1")).get()!.c ?? "[]"
  ) as string[];

const call = async (categories: string[]) =>
  (await server.invoke("update_event", { event_id: "e1", categories })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };

describe("update_event REFUSES an off-list category (it does not drop it)", () => {
  it("names the bad value and the allowed list, and writes nothing", async () => {
    const res = await call(["Craft Fsir"]);
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe("invalid_categories");
    expect(payload.invalid).toEqual(["Craft Fsir"]);
    expect(payload.allowed).toContain("Craft Fair");
    // The whole call is refused — a partial write would leave the row in a
    // state the caller never asked for.
    expect(stored()).toEqual(["Event"]);
  });

  it("refuses even when only ONE value in the list is off-list", async () => {
    const res = await call(["Craft Fair", "Hamfest"]);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).invalid).toEqual(["Hamfest"]);
    expect(stored()).toEqual(["Event"]);
  });

  it("accepts a newly-ratified value — the Hamfest case, now storable", async () => {
    const res = await call(["Amateur Radio Convention"]);
    expect(res.isError, res.content?.[0]?.text).toBeFalsy();
    expect(stored()).toEqual(["Amateur Radio Convention"]);
  });

  it("accepts 'Market', which /events/markets has been serving all along", async () => {
    const res = await call(["Market"]);
    expect(res.isError, res.content?.[0]?.text).toBeFalsy();
    expect(stored()).toEqual(["Market"]);
  });

  it("a call that names no categories is untouched by the gate", async () => {
    const res = (await server.invoke("update_event", {
      event_id: "e1",
      description: "Unrelated edit",
    })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(stored()).toEqual(["Event"]);
  });
});
