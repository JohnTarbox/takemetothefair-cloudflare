/**
 * OPE-1481 (a) — `events.parking_notes` / `events.accessibility_notes`, MCP
 * side. John's rule (2026-10-17): citation required, events only. Pinned the
 * same way as pet_friendly (OPE-1061): evidence or refusal with nothing
 * half-written, the citation carries the organizer's words verbatim, a clear
 * retires the citation, and the admin reader returns what the writer wrote.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerAdminEventReadTools } from "../src/tools/admin-event-read.js";
import { events, promoters, eventDataCitations } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "b1481000-0000-4000-8000-000000000001";
const SRC = "https://www.stonezoo.org/faq/";
const PARKING = "Free parking is available in the main lot; accessible spaces by the entrance.";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  registerAdminEventReadTools(server as never, db, ADMIN_AUTH as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Stone Zoo Boo at the Zoo 2026",
      slug: "stone-zoo-boo-at-the-zoo-2026",
      promoterId: "p-1",
      status: "APPROVED",
    })
    .run();
});
afterEach(() => mock.restore());

function body(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  let json: Record<string, unknown> | string;
  try {
    json = JSON.parse(r.content[0].text);
  } catch {
    json = r.content[0].text;
  }
  return { isError: !!r.isError, json: json as Record<string, unknown> };
}
const eventRow = () => db.select().from(events).where(eq(events.id, EVENT_ID)).all()[0];
const citations = (field: string) =>
  db
    .select()
    .from(eventDataCitations)
    .where(and(eq(eventDataCitations.eventId, EVENT_ID), eq(eventDataCitations.fieldName, field)))
    .all();
const evidence = (excerpt = PARKING) => ({
  source_url: SRC,
  source_type: "official_website",
  excerpt,
});

describe("update_event — no citation, no visitor note (OPE-1481)", () => {
  it.each([
    ["parking_notes", "a note with no evidence", { parking_notes: PARKING }],
    [
      "accessibility_notes",
      "a note with no evidence",
      { accessibility_notes: "Wheelchair accessible." },
    ],
    ["parking_notes", "evidence with no value", { parking_notes_evidence: evidence() }],
  ])("%s: refuses %s — and writes NOTHING", async (field, _label, args) => {
    const r = body(await server.invoke("update_event", { event_id: EVENT_ID, ...args }));
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe(`${field}_evidence_required`);
    expect(eventRow().parkingNotes).toBeNull();
    expect(eventRow().accessibilityNotes).toBeNull();
    expect(citations(field)).toHaveLength(0);
  });

  it("refuses evidence whose excerpt is blank — and writes nothing", async () => {
    const r = body(
      await server.invoke("update_event", {
        event_id: EVENT_ID,
        parking_notes: PARKING,
        parking_notes_evidence: evidence(""),
      })
    );
    expect(r.isError).toBe(true);
    expect(eventRow().parkingNotes).toBeNull();
    expect(citations("parking_notes")).toHaveLength(0);
  });

  it("writes the note with a citation carrying the verbatim excerpt, and the reader returns it", async () => {
    const r = body(
      await server.invoke("update_event", {
        event_id: EVENT_ID,
        parking_notes: PARKING,
        parking_notes_evidence: evidence(),
      })
    );
    expect(r.isError).toBe(false);
    expect(eventRow().parkingNotes).toBe(PARKING);
    const [c] = citations("parking_notes");
    expect(c).toMatchObject({
      value: PARKING,
      sourceUrl: SRC,
      sourceExcerpt: PARKING,
      state: "active",
    });
    expect(r.json.parking_notesCitationId).toBe(c.id);
    // The other note is untouched — one field's evidence never cites another.
    expect(eventRow().accessibilityNotes).toBeNull();
    expect(citations("accessibility_notes")).toHaveLength(0);

    const read = body(await server.invoke("get_event_details_admin", { event_id: EVENT_ID }));
    expect(JSON.stringify(read.json)).toContain(`"parking_notes":${JSON.stringify(PARKING)}`);
  });

  it("a rewrite supersedes the prior citation; a clear (null) retires it and writes none", async () => {
    await server.invoke("update_event", {
      event_id: EVENT_ID,
      accessibility_notes: "Wheelchair accessible.",
      accessibility_notes_evidence: evidence("The zoo is wheelchair accessible."),
    });
    await server.invoke("update_event", {
      event_id: EVENT_ID,
      accessibility_notes: "Wheelchairs available to rent.",
      accessibility_notes_evidence: evidence(
        "Wheelchairs are available to rent at Guest Services."
      ),
    });
    expect(
      citations("accessibility_notes")
        .map((c) => c.state)
        .sort()
    ).toEqual(["active", "superseded"]);

    const cleared = body(
      await server.invoke("update_event", { event_id: EVENT_ID, accessibility_notes: null })
    );
    expect(cleared.isError).toBe(false);
    expect(eventRow().accessibilityNotes).toBeNull();
    expect(citations("accessibility_notes").every((c) => c.state === "superseded")).toBe(true);
  });
});
