/**
 * OPE-516 — a correction never retired the machine's error.
 *
 * `auto_supersede_prior` matched on `(event_id, field_name, year)`. Every
 * citation the inbound pipeline writes carries `year: null`; every citation a
 * human writes carries a real year. Under one shared key the two groups can
 * never retire each other, so a correction lands BESIDE the wrong value instead
 * of replacing it.
 *
 * Live specimen, event `13f7f7a4-…` (Revolutionary Fair, Otisfield ME): the
 * classifier invented "Revolutionary Era Artisan Event" from a pasted Facebook
 * description and cited it at `year: null`. Correcting to "Revolutionary Fair"
 * with `year: 2026` returned `superseded_count: 0` and left TWO active `name`
 * citations with different values.
 *
 * ⚠️ The ticket's diagnosis — "almost certainly an unexamined `WHERE year = ?`"
 * — was right about the effect and wrong about the cause. `sameKeyFilter`
 * handled NULL deliberately and carried a comment defending the bucket. The
 * defect is SEMANTIC: `year` was doing two jobs, "which edition does this
 * describe" and "which supersede bucket is this in", and the second breaks the
 * first.
 *
 * It fails in the CORRECTING direction only, which is the worst possible bias:
 * the unattended writer is fine and the rare deliberate fix is what fails.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters, eventDataCitations } from "../src/schema.js";
import { eq } from "drizzle-orm";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "13f7f7a4-fae4-4272-b1b3-8262bf531195";

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
      name: "Revolutionary Fair",
      slug: "revolutionary-fair-2026",
      promoterId: "p-1",
      status: "APPROVED",
    })
    .run();
});
afterEach(() => mock.restore());

function parseJson(result: unknown) {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

async function cite(over: Record<string, unknown>) {
  return parseJson(
    await server.invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "name",
      value: "Revolutionary Fair",
      source_url: "https://example.com/poster.jpg",
      // OPE-530: was "organizer_site", which is NOT in SOURCE_TYPE_VALUES.
      // These seven tests were exercising supersede logic with a source_type
      // the real MCP boundary rejects outright — the harness never ran the
      // enum. Fixture corrected; the schema is right as it stands.
      source_type: "official_website",
      update_event_column: false,
      ...over,
    })
  );
}

function activeOnly() {
  return db
    .select({
      value: eventDataCitations.value,
      year: eventDataCitations.year,
      state: eventDataCitations.state,
    })
    .from(eventDataCitations)
    .where(eq(eventDataCitations.state, "active"))
    .all()
    .filter(() => true);
}

describe("a year-stamped correction retires the pipeline's year-null citation", () => {
  it("reproduces the live specimen and now supersedes it", async () => {
    // The pipeline's invented name, exactly as prod recorded it.
    await cite({
      value: "Revolutionary Era Artisan Event",
      source_name: "Email body",
      confidence: 0.6,
    });

    // The human correction, with a year — the write that used to no-op.
    const out = await cite({ value: "Revolutionary Fair", year: 2026, confidence: 0.95 });

    expect(out.superseded_count).toBe(1);
    const active = activeOnly();
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("Revolutionary Fair");
  });

  it("leaves a DIFFERENT edition's citation alone", async () => {
    // The reason the year bucket existed at all. A 2025 fact is not superseded
    // by a 2026 one; destroying per-edition provenance would be a worse bug.
    await cite({ value: "Revolutionary Fair 2025", year: 2025 });
    const out = await cite({ value: "Revolutionary Fair", year: 2026 });

    expect(out.superseded_count).toBe(0);
    expect(activeOnly()).toHaveLength(2);
  });

  it("reports the surviving edition rather than a bare zero", async () => {
    // `superseded_count: 0` is legitimate (first citation for a field), so it is
    // indistinguishable from success. A caller cannot check for a conflict it is
    // not told about.
    await cite({ value: "Revolutionary Fair 2025", year: 2025 });
    const out = await cite({ value: "Revolutionary Fair", year: 2026 });

    // The list describes what SURVIVES this write, so it excludes the row just
    // written — otherwise every call would report a conflict with itself.
    expect(out.conflicts_remaining).toHaveLength(1);
    expect(out.conflicts_remaining[0].year).toBe(2025);
    expect(out.conflicts_remaining[0].value).toBe("Revolutionary Fair 2025");
  });
});

describe("a year-null write does NOT destroy year-stamped citations", () => {
  it("supersedes only the other year-null row", async () => {
    // The ticket asked for "and vice versa". Deliberately not done: the pipeline
    // writes year-null at scale, unattended. If a null citation retired every
    // stamped row, one re-ingest would wipe out every per-edition citation a
    // human recorded — strictly worse than the bug, and in the same direction.
    await cite({ value: "Edition 2026", year: 2026 });
    await cite({ value: "Pipeline guess", source_name: "Email body" });

    const out = await cite({ value: "Pipeline guess 2", source_name: "Email body" });

    expect(out.superseded_count).toBe(1); // the earlier null row only
    const active = activeOnly();
    expect(active.some((c) => c.year === 2026 && c.value === "Edition 2026")).toBe(true);
  });

  it("surfaces them in conflicts_remaining", async () => {
    await cite({ value: "Edition 2026", year: 2026 });
    const out = await cite({ value: "Pipeline guess", source_name: "Email body" });

    // The 2026 row it deliberately did not touch is named, so the caller can
    // see the state it is leaving behind rather than inferring it.
    expect(out.conflicts_remaining.map((c: { year: number | null }) => c.year)).toEqual([2026]);
  });
});

describe("the ordinary case is unchanged", () => {
  it("a first citation for a field supersedes nothing and conflicts with nothing", async () => {
    const out = await cite({ value: "Revolutionary Fair", year: 2026 });
    expect(out.superseded_count).toBe(0);
    expect(out.conflicts_remaining).toEqual([]);
  });

  it("two year-null citations still supersede each other, as they always did", async () => {
    // The workaround the ticket documented (re-issue with year omitted) worked
    // for exactly this reason, and must keep working.
    await cite({ value: "First" });
    const out = await cite({ value: "Second" });
    expect(out.superseded_count).toBe(1);
    expect(activeOnly()).toHaveLength(1);
  });
});
