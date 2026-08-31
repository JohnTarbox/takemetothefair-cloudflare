/**
 * OPE-692 — a citation must be answerable without re-fetching its source.
 *
 * `source_url` was written so a later pass could confirm the source still says
 * what we recorded. It cannot: an unattended pass's `web_fetch` accepts a URL
 * only from a user message, a prior fetch result, or a search result, and a URL
 * read out of THIS table is none of those. So the citation was write-only.
 *
 * The Harmony Free Fair specimen is what these guard. Its citation points at
 * `harmonyfreefair.com`, which returns zero search results, while an abandoned
 * 2024 weebly mirror ranks first — and a sweep came one step from filing "the
 * 2024 program has been day-shifted onto 2026 dates" as a live defect. What
 * stopped it was reading the citation, not verifying it. After this, the
 * citation carries the evidence to settle that on its own.
 *
 * Two properties matter most, and both are ways this could ship green and still
 * mislead:
 *   1. `source_fetched_at` must never be set without something actually
 *      captured — a bare timestamp asserts "we read the page" while carrying no
 *      evidence that we did, which IS the fabricated-provenance shape.
 *   2. `unreachable` must stay distinct from null. "Tried and refused" and
 *      "never tried" justify opposite actions.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerCitationTools } from "../src/tools/admin-citations.js";
import { events, eventDataCitations, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const EVENT_ID = "11111111-2222-3333-4444-555555555555";

let db: TestDb;
let server: CapturingMcpServer;

async function invoke(name: string, params: Record<string, unknown>) {
  const res = (await server.invoke(name, params)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { res, json: JSON.parse(res.content[0].text) as Record<string, unknown> };
}

function citationRows() {
  return db.select().from(eventDataCitations).all();
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerCitationTools(server as never, db, ADMIN_AUTH);
  // events.promoter_id is NOT NULL — every event has an owning promoter, even
  // one minted by ingestion.
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Harmony Grange", slug: "harmony-grange" } as never)
    .run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Harmony Free Fair",
      slug: "harmony-free-fair-2026",
      promoterId: "promoter-1",
      status: "APPROVED",
    } as never)
    .run();
});

describe("the citation carries its own evidence", () => {
  it("stores the title, excerpt and hash the caller read", async () => {
    await invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "start_date",
      value: "2026-09-04",
      source_url: "https://harmonyfreefair.com/elementor-page-3922/",
      source_type: "official_website",
      source_title: "Join Us for 2026! September 4th - September 7th, 2026",
      source_excerpt: "Join Us for 2026! September 4th - September 7th, 2026",
      source_content_hash: "e3b0c44298fc1c14",
    });

    const [row] = citationRows();
    expect(row.sourceTitle).toContain("2026");
    expect(row.sourceExcerpt).toContain("September 4th");
    expect(row.sourceContentHash).toBe("e3b0c44298fc1c14");
    // A reader can now tell the live 2026 page from the abandoned 2024 mirror
    // without fetching anything.
    expect(row.sourceFetchedAt).toBeInstanceOf(Date);
  });

  it("does NOT stamp source_fetched_at when nothing was captured", async () => {
    // The load-bearing case. A timestamp with no title, excerpt or hash claims
    // "we read the page at this time" while carrying no evidence of it — a
    // fabricated provenance record, which is the defect class this rail exists
    // to prevent rather than to commit.
    await invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "end_date",
      value: "2026-09-07",
      source_url: "https://harmonyfreefair.com/",
      source_type: "official_website",
    });

    const [row] = citationRows();
    expect(row.sourceFetchedAt).toBeNull();
    expect(row.sourceTitle).toBeNull();
  });

  it("one captured field is enough to count as read", async () => {
    // Partial evidence is still evidence — requiring all three would push
    // callers to leave everything blank when they only have the title.
    await invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "name",
      value: "Harmony Free Fair",
      source_url: "https://harmonyfreefair.com/",
      source_type: "official_website",
      source_title: "Harmony Free Fair",
    });
    const [row] = citationRows();
    expect(row.sourceFetchedAt).toBeInstanceOf(Date);
  });
});

describe("list surfaces whether there is anything to check against", () => {
  it("reports source_verifiable and the snapshot", async () => {
    await invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "start_date",
      value: "2026-09-04",
      source_url: "https://harmonyfreefair.com/elementor-page-3922/",
      source_type: "official_website",
      source_title: "Join Us for 2026!",
    });

    const { json } = await invoke("list_event_citations", { event_id: EVENT_ID });
    const rows = json.citations as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].source_verifiable).toBe(true);
    expect(rows[0].source_title).toBe("Join Us for 2026!");
    // Never attempted — deliberately not the same as 'unreachable'.
    expect(rows[0].recheck_state).toBeNull();
  });

  it("source_verifiable is FALSE for a citation written before any snapshot", async () => {
    // Every pre-OPE-692 row looks like this. Reporting it honestly is the point:
    // "there is nothing here to check" is a different answer from "this is
    // wrong", and conflating them is how a good record gets retracted.
    await invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "start_date",
      value: "2026-09-04",
      source_url: "https://harmonyfreefair.com/",
      source_type: "official_website",
    });
    const { json } = await invoke("list_event_citations", { event_id: EVENT_ID });
    const rows = json.citations as Array<Record<string, unknown>>;
    expect(rows[0].source_verifiable).toBe(false);
  });
});

describe("unreachability becomes a fact on the citation", () => {
  it("records 'unreachable' with a reason, and stamps the time server-side", async () => {
    await invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "start_date",
      value: "2026-09-04",
      source_url: "https://harmonyfreefair.com/",
      source_type: "official_website",
    });
    const [created] = citationRows();

    await invoke("update_event_citation", {
      citation_id: created.id,
      recheck_state: "unreachable",
      recheck_note:
        "web_fetch refused: URL not in the provenance set, and the domain returns zero search results",
    });

    const [row] = db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.id, created.id))
      .all();
    expect(row.recheckState).toBe("unreachable");
    expect(row.recheckNote).toContain("provenance");
    // Server-stamped, not caller-supplied: a self-reported "I checked at T" is
    // precisely the claim this ticket is about not being able to trust.
    expect(row.recheckAt).toBeInstanceOf(Date);
  });

  it("leaves the citation ACTIVE — unreachable is about the URL, not the event", async () => {
    // The failure this prevents: treating "I could not look" as "the record is
    // wrong" and retracting a good citation. The two are opposite conclusions
    // from the same observation.
    await invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "start_date",
      value: "2026-09-04",
      source_url: "https://harmonyfreefair.com/",
      source_type: "official_website",
    });
    const [created] = citationRows();

    await invoke("update_event_citation", {
      citation_id: created.id,
      recheck_state: "unreachable",
      recheck_note: "refused",
    });

    const [row] = db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.id, created.id))
      .all();
    expect(row.state).toBe("active");
  });

  it("distinguishes confirmed from changed", async () => {
    await invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "start_date",
      value: "2026-09-04",
      source_url: "https://harmonyfreefair.com/",
      source_type: "official_website",
    });
    const [created] = citationRows();

    await invoke("update_event_citation", {
      citation_id: created.id,
      recheck_state: "confirmed",
      recheck_note: "page still reads September 4th - September 7th, 2026",
    });
    let [row] = db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.id, created.id))
      .all();
    expect(row.recheckState).toBe("confirmed");

    await invoke("update_event_citation", {
      citation_id: created.id,
      recheck_state: "changed",
      recheck_note: "page now reads 2027 dates",
    });
    [row] = db.select().from(eventDataCitations).where(eq(eventDataCitations.id, created.id)).all();
    expect(row.recheckState).toBe("changed");
  });
});
