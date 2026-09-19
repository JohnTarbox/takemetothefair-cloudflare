/**
 * OPE-1065 — a verification pass that finds a LIVE field wrong must produce a
 * countable work item, not only a sentence in `event_data_citations.notes`.
 *
 * Specimen: Harwich Cranberry festival, 2026-09-17. Citation 59944862 recorded
 * "Our description repeats it — flagged, not re-asserted" about a parking claim;
 * a member of the public asked about that exact claim four minutes later, and
 * the page stayed wrong until a human happened to read the note.
 *
 * The two triggers are structural (declared `live_defect`, and a cited value
 * that differs from the live column when the caller chose not to apply it), not
 * a text match on notes — measured on prod, a notes regex is wrong both ways.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters, eventDiscrepancies, eventDataCitations } from "../src/schema.js";
import { fieldClassForCitationField } from "../src/goodwill/citation-flag-capture.js";
import { rerankOpenQueueBatch } from "../src/goodwill/queue-ranking.js";
import { updateReliability } from "../src/goodwill/scoring.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "bc3be9e26c6129c4b9b0b170f70eb065";
const SRC = "https://www.harwichcranberryartsandmusicfestival.org/cranjam2026";
const DESCRIPTION = "A two-day arts and music festival, with ample free parking.";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: "p" })
    .onConflictDoNothing()
    .run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Harwich Cranberry Arts & Music Festival 2026",
      slug: "harwich-cranberry-2026",
      promoterId: "p-1",
      status: "APPROVED",
      description: DESCRIPTION,
      ticketPriceMaxCents: 1000,
      // ET-midnight storage, NOT the noon-UTC house convention — the ~25% of
      // rows OPE-1011 measured. A same-day citation must not read as a defect.
      startDate: new Date("2026-09-19T04:00:00Z"),
      viewCount: 1234,
    })
    .run();
});
afterEach(() => mock.restore());

function parseJson(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

function flagRows() {
  return db
    .select()
    .from(eventDiscrepancies)
    .where(
      and(
        eq(eventDiscrepancies.eventId, EVENT_ID),
        eq(eventDiscrepancies.detectedBy, "citation_flag")
      )
    )
    .all();
}

async function cite(over: Record<string, unknown>) {
  return parseJson(
    await server.invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "ticket_price_max",
      value: "0",
      source_url: SRC,
      source_type: "official_website",
      ...over,
    })
  );
}

describe("declared live_defect — the specimen, filed in the same call", () => {
  it("files one open citation_flag row for a DIFFERENT live field than the one cited", async () => {
    const res = await cite({
      notes: "Our description repeats it — flagged, not re-asserted.",
      live_defect: {
        field: "description",
        kind: "unsupported",
        reason: "'Ample Free Parking' appears only on archived 2024 entries; no 2026 page says it.",
      },
    });

    expect(res.live_defects).toHaveLength(1);
    expect(res.live_defects[0]).toMatchObject({
      outcome: "created",
      field_class: "other",
      trigger: "declared",
    });

    const rows = flagRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(res.live_defects[0].discrepancy_id);
    expect(row.resolutionStatus).toBe("open");
    expect(row.fieldClass).toBe("other");
    // The live value is READ from the column, not asserted by the caller.
    expect(row.authoritativeValue).toBe(DESCRIPTION);
    expect(row.divergentSourceUrl).toBe(SRC);
    // `unsupported` on a different field: the cited "0" is not what the source
    // says about the description, so it must not be recorded as if it were.
    expect(row.divergentValue).toBeNull();
    expect(row.notes).toContain("[description] unsupported (declared, citation ");
    // Never promoter outreach, and never a reliability signal.
    expect(row.outreachCandidate).toBe(false);
    expect(row.authoritativeSourceKey).toBeNull();
    expect(row.divergentSourceKey).toBeNull();
  });

  it("files nothing when no live_defect is passed and the value was applied (default path)", async () => {
    const res = await cite({ notes: "Our description repeats it — flagged, not re-asserted." });
    // Positive landmark: the citation WAS written and the column WAS applied,
    // so the absence below is a decision, not a path that did not run.
    expect(res.event_column_updated).toBe("ticketPriceMaxCents");
    expect(res.live_defects).toEqual([]);
    expect(flagRows()).toHaveLength(0);
  });
});

describe("cited_value_differs — automatic, no argument to forget", () => {
  it("files a contradicted row when a differing value is cited with update_event_column=false", async () => {
    const res = await cite({ update_event_column: false, value: "15" });

    expect(res.event_column_updated).toBeNull();
    expect(res.live_defects).toHaveLength(1);
    expect(res.live_defects[0]).toMatchObject({
      outcome: "created",
      field_class: "price",
      trigger: "cited_value_differs",
    });
    const [row] = flagRows();
    expect(row.authoritativeValue).toBe("1000");
    expect(row.divergentValue).toBe("1500");
    expect(row.notes).toContain("[ticket_price_max] contradicted (cited_value_differs");

    // The live column is untouched — this reports the disagreement, it does
    // not resolve it.
    const [ev] = db.select().from(events).where(eq(events.id, EVENT_ID)).all();
    expect(ev.ticketPriceMaxCents).toBe(1000);
  });

  it("files nothing when the cited value agrees with the live column", async () => {
    const res = await cite({ update_event_column: false, value: "10" });
    expect(res.live_defects).toEqual([]);
    expect(flagRows()).toHaveLength(0);
  });

  it("compares dates by calendar day: same day at a different hour is NOT a defect, a different day IS", async () => {
    const same = await cite({
      field_name: "start_date",
      value: "2026-09-19",
      update_event_column: false,
    });
    expect(same.live_defects).toEqual([]);
    expect(flagRows()).toHaveLength(0);

    const other = await cite({
      field_name: "start_date",
      value: "2026-09-20",
      update_event_column: false,
    });
    expect(other.live_defects).toHaveLength(1);
    expect(other.live_defects[0]).toMatchObject({ field_class: "date", outcome: "created" });
  });

  it("does not double-file when the caller also declared the same field", async () => {
    const res = await cite({
      update_event_column: false,
      value: "15",
      live_defect: { kind: "contradicted", reason: "Organizer page says $15." },
    });
    expect(res.live_defects).toHaveLength(1);
    expect(res.live_defects[0].trigger).toBe("declared");
    expect(flagRows()).toHaveLength(1);
  });
});

describe("one row per (event, field_class), each field kept", () => {
  it("appends a second field of the same class and recognises a repeat of the first", async () => {
    const a = await cite({ update_event_column: false, value: "15" });
    const b = await cite({
      field_name: "ticket_price_min",
      update_event_column: false,
      value: "5",
    });
    const again = await cite({ update_event_column: false, value: "15" });

    expect(a.live_defects[0].outcome).toBe("created");
    expect(b.live_defects[0].outcome).toBe("appended");
    expect(again.live_defects[0].outcome).toBe("already_recorded");

    const rows = flagRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toContain("[ticket_price_max]");
    expect(rows[0].notes).toContain("[ticket_price_min]");
    expect(rows[0].notes!.match(/\[ticket_price_max\]/g)).toHaveLength(1);
  });
});

describe("the other two writers", () => {
  it("bulk_create_event_citations files per row and rolls the count up", async () => {
    const res = parseJson(
      await server.invoke("bulk_create_event_citations", {
        citations: [
          {
            event_id: EVENT_ID,
            field_name: "ticket_price_max",
            value: "15",
            source_url: SRC,
            source_type: "official_website",
            update_event_column: false,
          },
          {
            event_id: EVENT_ID,
            field_name: "start_date",
            value: "2026-09-19",
            source_url: SRC,
            source_type: "official_website",
            update_event_column: false,
          },
        ],
      })
    );
    expect(res.created_count).toBe(2);
    expect(res.live_defects_filed).toBe(1);
    expect(res.live_defects_failed).toBe(0);
    expect(res.created[0].live_defects).toHaveLength(1);
    expect(res.created[1].live_defects).toEqual([]);
  });

  it("update_event_citation files a finding against an EXISTING citation (the backfill route)", async () => {
    const created = await cite({});
    const res = parseJson(
      await server.invoke("update_event_citation", {
        citation_id: created.citation_id,
        live_defect: {
          field: "description",
          kind: "unsupported",
          reason: "Parking claim unsupported for 2026.",
        },
      })
    );
    expect(res.live_defects).toHaveLength(1);
    expect(res.live_defects[0].outcome).toBe("created");
    const [row] = flagRows();
    expect(row.notes).toContain(`citation ${created.citation_id.slice(0, 8)}`);
    // The citation itself is unchanged by filing against it.
    const [c] = db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.id, created.citation_id))
      .all();
    expect(c.state).toBe("active");
  });
});

describe("the queue: findable by detector, never outreach", () => {
  it("list_event_discrepancies(detected_by='citation_flag') returns only citation flags", async () => {
    await cite({ update_event_column: false, value: "15" });
    db.insert(eventDiscrepancies)
      .values({
        id: "d-manual",
        eventId: EVENT_ID,
        fieldClass: "price",
        detectedBy: "manual",
        detectedAt: new Date(),
        resolutionStatus: "open",
        outreachCandidate: false,
      })
      .run();

    const res = parseJson(
      await server.invoke("list_event_discrepancies", { detected_by: "citation_flag" })
    );
    expect(res.count).toBe(1);
    expect(res.rows[0].detectedBy).toBe("citation_flag");
    const all = parseJson(await server.invoke("list_event_discrepancies", {}));
    expect(all.count).toBe(2);
  });

  it("rerank holds outreach_candidate false for citation_flag while an identical manual row is promoted", async () => {
    const base = {
      eventId: EVENT_ID,
      fieldClass: "date" as const,
      detectedAt: new Date(),
      confidence: 1,
      resolutionStatus: "open" as const,
      outreachCandidate: false,
    };
    db.insert(eventDiscrepancies)
      .values([
        { ...base, id: "d-flag", detectedBy: "citation_flag" },
        { ...base, id: "d-control", detectedBy: "manual" },
      ])
      .run();

    await rerankOpenQueueBatch(db, { limit: 100 });
    const rows = db.select().from(eventDiscrepancies).all();
    const flag = rows.find((r) => r.id === "d-flag")!;
    const control = rows.find((r) => r.id === "d-control")!;

    // Landmark: the control proves these inputs DO clear the threshold, so
    // the flag row's `false` is the exclusion, not a low score.
    expect(control.outreachCandidate).toBe(true);
    expect(flag.outreachPriorityScore!).toBeCloseTo(control.outreachPriorityScore!, 6);
    expect(flag.outreachCandidate).toBe(false);
  });

  it("resolving an `other` row scores no source_reliability cell", async () => {
    db.insert(eventDiscrepancies)
      .values({
        id: "d-other",
        eventId: EVENT_ID,
        fieldClass: "other",
        detectedBy: "manual",
        detectedAt: new Date(),
        divergentSourceKey: "example.org",
        resolutionStatus: "resolved_divergent",
        outreachCandidate: false,
      })
      .run();
    const r = await updateReliability(db, "d-other");
    expect(r).toEqual({ decision: "skipped_no_source", cellsTouched: 0 });
  });
});

describe("fieldClassForCitationField", () => {
  it.each([
    ["start_date", "date"],
    ["application_deadline", "date"],
    ["venue_id", "venue"],
    ["ticket_price_max", "price"],
    ["vendor_fee_notes", "price"],
    ["schedule", "hours"],
    ["name", "name"],
    ["status", "status"],
    ["description", "other"],
    ["indoor_outdoor", "other"],
  ])("%s → %s", (field, cls) => {
    expect(fieldClassForCitationField(field)).toBe(cls);
  });
});
