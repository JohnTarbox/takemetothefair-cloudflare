/**
 * K21 (2026-06-12) — suggest_event category handling.
 *
 * Before K21, categories not on the canonical EVENT_CATEGORIES allow-list
 * were silently coerced to ["Event"] with no signal in the response, so a
 * steady stream of mis-categorized community/email submissions leaked into
 * the uncategorized queue invisibly. These tests pin the new behavior:
 *   - valid categories are stored verbatim, no warnings;
 *   - off-list categories are dropped from storage but echoed back in
 *     warnings.dropped_categories;
 *   - a mix keeps the valid subset and warns about the rest;
 *   - all-off-list falls back to ["Event"] AND warns.
 *
 * Uses the in-memory SQLite + CapturingMcpServer harness (see setup-db.ts).
 * No venue and no env are supplied, so the dedup guard (keys on venue+date)
 * and the IndexNow ping are both skipped — keeping the test focused on the
 * category branch.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { events, users } from "../src/schema.js";

const AUTH = { userId: "u-submitter", role: "USER" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(users).values({ id: "u-submitter", email: "submitter@test", role: "USER" }).run();
  registerVendorTools(server as never, db, AUTH, undefined);
});

interface SuggestPayload {
  created: boolean;
  event: { id: string; slug: string; name: string; status: string };
  warnings?: { dropped_categories?: string[] };
}

async function suggest(args: Record<string, unknown>) {
  const result = (await server.invoke("suggest_event", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return {
    isError: !!result.isError,
    payload: result.isError ? null : (JSON.parse(result.content[0].text) as SuggestPayload),
    errorText: result.isError ? result.content[0].text : null,
  };
}

async function storedCategories(eventId: string): Promise<string[]> {
  const rows = await db
    .select({ categories: events.categories })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return JSON.parse(rows[0].categories ?? "[]");
}

describe("suggest_event categories (K21)", () => {
  it("stores valid categories verbatim with no warnings", async () => {
    const { isError, payload } = await suggest({
      name: "Kingfield Craft Fair",
      start_date: "2026-09-15",
      categories: ["Craft Fair", "Festival"],
    });

    expect(isError).toBe(false);
    expect(payload?.created).toBe(true);
    expect(await storedCategories(payload!.event.id)).toEqual(["Craft Fair", "Festival"]);
    // No drop happened → no warnings key at all.
    expect(payload?.warnings).toBeUndefined();
  });

  it("stores a newly-reconciled category that used to be dropped", async () => {
    // "Gun Show" was the surfacing case for K21 — off-list before, now canonical.
    const { payload } = await suggest({
      name: "Big Pine Gun Show 2027",
      start_date: "2027-03-01",
      categories: ["Gun Show"],
    });

    expect(await storedCategories(payload!.event.id)).toEqual(["Gun Show"]);
    expect(payload?.warnings).toBeUndefined();
  });

  it("keeps the valid subset and warns about off-list values in a mix", async () => {
    const { payload } = await suggest({
      name: "Mixed Tag Event",
      start_date: "2026-10-01",
      categories: ["Festival", "Llama Yoga", "Craft Fair", "Underwater Basket Weaving"],
    });

    expect(await storedCategories(payload!.event.id)).toEqual(["Festival", "Craft Fair"]);
    expect(payload?.warnings?.dropped_categories).toEqual([
      "Llama Yoga",
      "Underwater Basket Weaving",
    ]);
  });

  it("falls back to ['Event'] AND warns when every category is off-list", async () => {
    const { payload } = await suggest({
      name: "Totally Uncategorizable Gathering",
      start_date: "2026-11-11",
      categories: ["Llama Yoga"],
    });

    expect(await storedCategories(payload!.event.id)).toEqual(["Event"]);
    expect(payload?.warnings?.dropped_categories).toEqual(["Llama Yoga"]);
  });

  it("omits warnings when no categories are supplied at all", async () => {
    const { payload } = await suggest({
      name: "No Category Event",
      start_date: "2026-12-01",
    });

    // Legacy ["Event"] fallback still applies, but nothing was *dropped*,
    // so there is no dropped_categories warning to surface.
    expect(await storedCategories(payload!.event.id)).toEqual(["Event"]);
    expect(payload?.warnings).toBeUndefined();
  });
});
