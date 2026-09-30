/**
 * OPE-1110 — `update_event` must either RECORD a passed citation or SAY it
 * did not.
 *
 * Measured by the analyst lane on four real reassignments off
 * `system-community-suggestions`: a `promoter_id`-only call carrying a full
 * citation returned no error, no warning and no `citationsInserted` key, and
 * left no row. Receipts then reported "(with citation)" for provenance that
 * never existed.
 *
 * Pinned from both sides, as the ticket's acceptance requires: the warning is
 * PRESENT when a citation is dropped and ABSENT when no citation was passed — a
 * "no silent discard" check that never fires would pass either way.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventDataCitations, events, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "evt-pemaquid";

const CITATION = {
  source_url: "https://www.pemaquidoysterfestival.com/about",
  source_name: "Pemaquid Oyster Festival — About",
  source_type: "official_website",
};

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  for (const [id, name] of [
    ["system-community-suggestions", "Community Suggestions"],
    ["p-damariscotta", "Damariscotta Chamber"],
  ])
    db.insert(promoters)
      .values({ id, companyName: name, slug: unsafeSlug(id) })
      .run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Pemaquid Oyster Festival 2026",
      slug: unsafeSlug("pemaquid-oyster-festival-2026"),
      promoterId: "system-community-suggestions",
      status: "APPROVED",
    })
    .run();
});
afterEach(() => mock.restore());

async function update(args: Record<string, unknown>) {
  const r = (await server.invoke("update_event", { event_id: EVENT_ID, ...args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text) as Record<string, unknown> & {
    citationsInserted?: Array<{ field_name: string }>;
    warnings?: Record<string, unknown>;
  };
}

const promoterCitations = () =>
  db
    .select()
    .from(eventDataCitations)
    .where(
      and(eq(eventDataCitations.eventId, EVENT_ID), eq(eventDataCitations.fieldName, "promoter_id"))
    )
    .all();

describe("promoter_id is citation-tracked", () => {
  it("ACCEPTANCE: a promoter_id-only reassignment WITH a citation records a promoter_id row", async () => {
    const res = await update({ promoter_id: "p-damariscotta", citation: CITATION });

    expect(res.citationsInserted?.map((c) => c.field_name)).toEqual(["promoter_id"]);
    const rows = promoterCitations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      value: "p-damariscotta",
      sourceUrl: CITATION.source_url,
      state: "active",
    });
    // Nothing was dropped, so nothing is warned about.
    expect(res.warnings?.citation_ignored_for).toBeUndefined();
  });

  it("a second reassignment supersedes the first (same rule as every tracked field)", async () => {
    await update({ promoter_id: "p-damariscotta", citation: CITATION });
    await update({
      promoter_id: "system-community-suggestions",
      citation: { ...CITATION, source_url: "https://example.org/correction" },
    });
    const rows = promoterCitations();
    expect(rows.map((r) => r.state).sort()).toEqual(["active", "superseded"]);
  });
});

describe("a citation that records nothing is SAID, never silent", () => {
  it("names each changed field the citation did not cover", async () => {
    const res = await update({
      promoter_id: "p-damariscotta",
      description: "Oysters, shucking contest, music.",
      citation: CITATION,
    });
    expect(res.citationsInserted?.map((c) => c.field_name)).toEqual(["promoter_id"]);
    expect(res.warnings?.citation_ignored_for).toEqual(["description"]);
    expect(String(res.warnings?.citation_ignored_message)).toContain("description");
  });

  it("ACCEPTANCE (the other side): no citation passed → no warning", async () => {
    const res = await update({ promoter_id: "p-damariscotta", description: "x" });
    expect(res.warnings?.citation_ignored_for).toBeUndefined();
    // Landmark: the write happened; the absence is not an absence of work.
    expect(promoterCitations()).toHaveLength(0);
    const [row] = db.select().from(events).where(eq(events.id, EVENT_ID)).all();
    expect(row.promoterId).toBe("p-damariscotta");
  });
});
