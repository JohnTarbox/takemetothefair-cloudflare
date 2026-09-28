/**
 * OPE-1200 — `update_event` writes dates_confirmed = true only with a qualifying
 * start_date citation (active, not a community submission, not an aggregator),
 * or a citation in the same call that lands on start_date.
 *
 * The four 2026-09-28 listings that sent visitors to the wrong day or state all
 * carried dates_confirmed = 1 with no current organizer source. Pinned from both
 * sides: a qualifying citation KEEPS true with no warning, so a gate that
 * downgraded everything would fail here too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventDataCitations, events, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "evt-harvest";

const ORGANIZER = {
  source_url: "https://www.castleberryfairs.com/harvest-festival",
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
  db.insert(promoters)
    .values({ id: "p-1", companyName: "Castleberry Fairs", slug: unsafeSlug("castleberry") })
    .run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Harvest Festival of Crafts",
      slug: unsafeSlug("harvest-festival-of-crafts-2026"),
      promoterId: "p-1",
      status: "APPROVED",
      startDate: new Date("2026-10-31T12:00:00Z"),
      endDate: new Date("2026-11-01T12:00:00Z"),
      datesConfirmed: false,
    })
    .run();
});
afterEach(() => mock.restore());

function seedCitation(
  sourceUrl: string,
  sourceType: string,
  state = "active",
  field = "start_date"
) {
  db.insert(eventDataCitations)
    .values({
      id: `c-${Math.random().toString(36).slice(2)}`,
      eventId: EVENT_ID,
      fieldName: field,
      value: "2026-10-31",
      sourceUrl,
      sourceType: sourceType as never,
      state: state as never,
    })
    .run();
}

async function update(args: Record<string, unknown>) {
  const r = (await server.invoke("update_event", { event_id: EVENT_ID, ...args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text) as Record<string, unknown> & {
    warnings?: Record<string, unknown>;
  };
}

const stored = () =>
  db.select({ v: events.datesConfirmed }).from(events).where(eq(events.id, EVENT_ID)).all()[0].v;

describe("update_event dates_confirmed gate (OPE-1200)", () => {
  it("no citation at all → written false, with a warning", async () => {
    const res = await update({ dates_confirmed: true });
    expect(stored()).toBe(false);
    expect(String(res.warnings?.dates_confirmed_downgraded)).toContain(
      "no active start_date citation"
    );
  });

  it("an active organizer citation on start_date → true, no warning (the other side)", async () => {
    seedCitation(ORGANIZER.source_url, "official_website");
    const res = await update({ dates_confirmed: true });
    expect(stored()).toBe(true);
    expect(res.warnings?.dates_confirmed_downgraded).toBeUndefined();
  });

  it.each([
    [
      "an aggregator host (the Tanger row's source)",
      "https://www.lakesregion.org/events/x",
      "official_website",
      "active",
      "start_date",
    ],
    [
      "a community submission",
      "https://www.castleberryfairs.com/x",
      "user_submitted",
      "active",
      "start_date",
    ],
    [
      "a superseded citation",
      "https://www.castleberryfairs.com/x",
      "official_website",
      "superseded",
      "start_date",
    ],
    [
      "a citation on end_date only",
      "https://www.castleberryfairs.com/x",
      "official_website",
      "active",
      "end_date",
    ],
  ])("only %s → written false", async (_label, url, type, state, field) => {
    seedCitation(url, type, state, field);
    const res = await update({ dates_confirmed: true });
    expect(stored()).toBe(false);
    expect(res.warnings?.dates_confirmed_downgraded).toBeDefined();
  });

  it("a citation in the same call that lands on start_date → true, and the row exists", async () => {
    const res = await update({
      dates_confirmed: true,
      start_date: "2026-10-31",
      citation: ORGANIZER,
    });
    expect(stored()).toBe(true);
    expect(res.warnings?.dates_confirmed_downgraded).toBeUndefined();
    const rows = db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.fieldName, "start_date"))
      .all();
    expect(rows.map((r) => r.sourceUrl)).toContain(ORGANIZER.source_url);
  });

  it("a same-call citation that would NOT land on start_date does not count", async () => {
    // No start_date in the call → update_event records no start_date citation,
    // so accepting it would confirm the dates with nothing on file.
    const res = await update({ dates_confirmed: true, citation: ORGANIZER });
    expect(stored()).toBe(false);
    expect(res.warnings?.dates_confirmed_downgraded).toBeDefined();
  });

  it("an aggregator citation passed in the same call → false, and says why", async () => {
    const res = await update({
      dates_confirmed: true,
      start_date: "2026-10-31",
      citation: {
        source_url: "https://www.lakesregion.org/events/x",
        source_type: "official_website",
      },
    });
    expect(stored()).toBe(false);
    expect(String(res.warnings?.dates_confirmed_downgraded)).toContain("aggregator");
  });

  it("dates_confirmed: false is written as asked, no warning", async () => {
    seedCitation(ORGANIZER.source_url, "official_website");
    await update({ dates_confirmed: true });
    const res = await update({ dates_confirmed: false });
    expect(stored()).toBe(false);
    expect(res.warnings?.dates_confirmed_downgraded).toBeUndefined();
  });
});
