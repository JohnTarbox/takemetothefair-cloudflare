/**
 * OPE-534 — every column `update_event` can WRITE must be readable through
 * `get_event_details_admin`.
 *
 * The live loss (2026-08-24, KCCV 6th Annual Holiday Craft Fair): the reader
 * returned no `application_url` key and no `vendor_fee_notes` key — not null,
 * ABSENT. Both were populated. Writing them from a poster destroyed the real
 * Zeffy application form and the only record of the prior Google-Form route,
 * with no error, no warning and (per OPE-505) no audit trail. It surfaced only
 * because `update_event` echoes `previousValues` and someone read the echo.
 *
 * The measured gap was **27 fields**, not the 11 the ticket had observed.
 *
 * This test is the acceptance criterion: it enumerates BOTH sides and fails
 * when they diverge, so the next column added to the writer cannot quietly
 * reintroduce the defect. That is only possible because OPE-530 made
 * `CapturingMcpServer` retain the zod shape it used to discard — before that,
 * the writer's field list was not introspectable from a test at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerAdminEventReadTools } from "../src/tools/admin-event-read.js";
import { events, users, promoters } from "../src/schema.js";

const AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(async () => {
  ({ db } = createTestDb());
  db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" }).run();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: "p" as never })
    .run();
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, AUTH, undefined);
  registerAdminEventReadTools(server as never, db, AUTH);
});

/**
 * Params that are CONTROL, not data — they steer the call rather than set a
 * column, so there is nothing for the reader to return.
 *
 * This list is deliberately short and each entry is justified. It is the only
 * escape hatch in this test, and a field quietly added here to make the test
 * pass would recreate exactly the blind spot the test exists to prevent.
 */
const NON_COLUMN_WRITER_PARAMS = new Set([
  "event_id", // addresses the row; not stored on it
  "citation", // writes event_data_citations, a different table
  "acknowledge_possible_duplicates", // suppresses a warning
  "defer_search_ping", // suppresses an IndexNow ping
]);

function flattenKeys(obj: unknown, out = new Set<string>()): Set<string> {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.add(k);
    if (v && typeof v === "object" && !Array.isArray(v)) flattenKeys(v, out);
  }
  return out;
}

async function seedEvent() {
  await db.insert(events).values({
    id: "ev-1",
    name: "Kingfield Craft Fair",
    slug: "kingfield-craft-fair" as never,
    promoterId: "p-1",
    status: "APPROVED",
  } as typeof events.$inferInsert);
}

async function readEvent(): Promise<Record<string, unknown>> {
  const res = (await server.invoke("get_event_details_admin", { event_id: "ev-1" })) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe("reader / writer parity", () => {
  it("exposes every writable column through the admin reader", async () => {
    const writer = server.schemas.get("update_event");
    expect(writer, "update_event must be registered").toBeDefined();

    await seedEvent();
    const reader = flattenKeys(await readEvent());
    const missing = Object.keys(writer!)
      .filter((k) => !NON_COLUMN_WRITER_PARAMS.has(k))
      .filter((k) => !reader.has(k))
      .sort();

    // Named in the failure so a future divergence says WHICH field, rather
    // than just that the counts differ.
    expect(
      missing,
      `update_event can write these but the reader never returns them: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("returns the fields the 2026-08-24 loss turned on, as keys that EXIST", async () => {
    // The specific regression. `toHaveProperty` rather than a truthiness check:
    // the defect was an ABSENT key, and a caller cannot tell "no value" from
    // "this tool does not report it" — only one of those is safe to overwrite.
    await seedEvent();
    const payload = await readEvent();
    for (const key of [
      "application_url",
      "application_instructions",
      "application_deadline",
      "vendor_fee_notes",
      "vendor_fee_min",
      "vendor_fee_max",
      "estimated_attendance",
      "image_url",
      "walk_ins_allowed",
      "commercial_vendors_allowed",
    ]) {
      expect(payload, `${key} must be a present key, not absent`).toHaveProperty(key);
    }
  });

  it("keeps the control-param exemption list honest", () => {
    // If this list grows, the test above gets weaker. Pinning its contents
    // makes widening it a deliberate, reviewable act.
    expect([...NON_COLUMN_WRITER_PARAMS].sort()).toEqual([
      "acknowledge_possible_duplicates",
      "citation",
      "defer_search_ping",
      "event_id",
    ]);
  });
});

describe("overwriting a non-null field is surfaced, not silent", () => {
  it("warns when update_event replaces a real application_url — the 2026-08-24 case", async () => {
    // The exact regression: a row holding the real Zeffy application form, and
    // a write that replaces it with the marketing landing page a poster's QR
    // pointed at. The destroyed value was the better one.
    await db.insert(events).values({
      id: "ev-kccv",
      name: "KCCV Holiday Craft Fair 2026",
      slug: "kccv-holiday-craft-fair-2026" as never,
      promoterId: "p-1",
      status: "APPROVED",
      applicationUrl: "https://www.kccvmaine.org/seller-application",
    } as typeof events.$inferInsert);

    const res = (await server.invoke("update_event", {
      event_id: "ev-kccv",
      application_url: "https://www.kccvmaine.org/annualholidaycraftfair",
    })) as { content: Array<{ text: string }> };
    const out = JSON.parse(res.content[0].text) as {
      warnings?: { overwrote_nonnull?: string[]; overwrote_nonnull_message?: string };
      previousValues?: Record<string, unknown>;
    };

    expect(out.warnings?.overwrote_nonnull).toContain("application_url");
    // The prior value must still be recoverable from the same response — it is
    // the only record that exists (OPE-505: field-level writes are unaudited).
    expect(out.previousValues?.application_url).toBe(
      "https://www.kccvmaine.org/seller-application"
    );
    expect(out.warnings?.overwrote_nonnull_message).toMatch(/no audit trail/i);
  });

  it("does NOT warn when filling a field that was empty", async () => {
    // Filling a blank is not an overwrite. Warning here would train the reader
    // to ignore the warning, which is worse than not having it.
    await db.insert(events).values({
      id: "ev-blank",
      name: "Blank",
      slug: "blank" as never,
      promoterId: "p-1",
      status: "APPROVED",
    } as typeof events.$inferInsert);

    const res = (await server.invoke("update_event", {
      event_id: "ev-blank",
      application_url: "https://example.org/apply",
    })) as { content: Array<{ text: string }> };
    const out = JSON.parse(res.content[0].text) as { warnings?: Record<string, unknown> };
    expect(out.warnings?.overwrote_nonnull).toBeUndefined();
  });

  it("does NOT warn when the same value is re-sent", async () => {
    // Idempotent re-writes are common in enrichment passes; a no-op rewrite is
    // not a loss and must stay quiet.
    await db.insert(events).values({
      id: "ev-same",
      name: "Same",
      slug: "same" as never,
      promoterId: "p-1",
      status: "APPROVED",
      applicationUrl: "https://example.org/apply",
    } as typeof events.$inferInsert);

    const res = (await server.invoke("update_event", {
      event_id: "ev-same",
      application_url: "https://example.org/apply",
    })) as { content: Array<{ text: string }> };
    const out = JSON.parse(res.content[0].text) as { warnings?: Record<string, unknown> };
    expect(out.warnings?.overwrote_nonnull).toBeUndefined();
  });
});
