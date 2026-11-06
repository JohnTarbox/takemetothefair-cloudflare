/**
 * OPE-1572 — a capacity claim over MCP carries its citation.
 *
 * The specimen: Shepherd Hill Festival of Crafts 2026 (`bf320360`) is full for
 * 2026 per the organizer's Facebook post of 2026-09-26, and the analyst had
 * nowhere structured to put it. OPE-1512's `upsert_event_application` is the
 * write path; this ticket makes the evidence REQUIRED for any status other
 * than UNKNOWN (OPE-794's discipline) and records it as an event_data_citations
 * row in the same batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  capacityCitationField,
  registerEventApplicationTools,
} from "../src/tools/admin-event-applications.js";
import { summarizeLaneCapacity } from "@takemetothefair/constants";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const NOW = new Date("2026-11-03T18:00:00Z");
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const FB_POST =
  "https://www.facebook.com/shepherdhillfestivalofcrafts/posts/pfbid03opguzydUbESUS6WDXDhtFTZDGL6TrAEyVYhZu1MjjxzQSj2gnGwB3ZyRZHGmZJxl";
const SHEPHERD = "bf320360-1414-4de3-936f-258a6fd70af5";

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = async (args: Record<string, unknown>) => {
  const r = (await server.invoke("upsert_event_application", args)) as Result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) as any };
};
const citations = () =>
  raw
    .prepare(
      "SELECT id, field_name, value, state, source_url, source_type, source_excerpt, notes, supersedes_citation_id FROM event_data_citations ORDER BY created_at, rowid"
    )
    .all() as Array<Record<string, unknown>>;
const lanes = () =>
  raw.prepare("SELECT lane, department, capacity_status FROM event_applications").all() as Array<{
    lane: string;
    department: string | null;
    capacity_status: string;
  }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ({ db, raw } = createTestDb());
  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin', 'a@t', 'ADMIN')").run();
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status)
       VALUES (?, 'Shepherd Hill Festival of Crafts 2026', 'shepherd-hill-festival-of-crafts-2026', 'p1', ?, ?, 'APPROVED')`
    )
    .run(SHEPHERD, T("2026-11-21T14:00:00Z"), T("2026-11-21T14:00:00Z"));
  server = new CapturingMcpServer();
  registerEventApplicationTools(server as never, db, ADMIN);
});
afterEach(() => vi.useRealTimers());

const SHEPHERD_FULL = {
  event_id: SHEPHERD,
  capacity_status: "FULL",
  capacity_as_of: "2026-09-26",
  capacity_evidence: {
    source_url: FB_POST,
    source_type: "social_media",
    source_name: "Shepherd Hill Festival of Crafts (Facebook)",
    excerpt: "WE ARE FULL FOR THIS YEAR",
  },
  reason: "organizer FB post 2026-09-26",
};

describe("OPE-1572 — capacity needs evidence", () => {
  it("ACCEPTANCE: Shepherd Hill set FULL as of 2026-09-26 writes the lane row AND an active citation", async () => {
    const r = await call(SHEPHERD_FULL);
    expect(r.isError).toBe(false);
    expect(r.body.after).toMatchObject({ capacity_status: "FULL", capacity_as_of: "2026-09-26" });
    expect(r.body.capacity_citation_id).toEqual(expect.any(String));
    const [c] = citations();
    expect(c).toMatchObject({
      id: r.body.capacity_citation_id,
      field_name: "vendor_capacity:commercial_vendor",
      value: "FULL",
      state: "active",
      source_url: FB_POST,
      source_type: "social_media",
      source_excerpt: "WE ARE FULL FOR THIS YEAR",
    });
    expect(String(c.notes)).toContain("as of 2026-09-26");
  });

  it("ACCEPTANCE: a FULL lane makes the event UNAVAILABLE, which the vendor digest drops", async () => {
    await call(SHEPHERD_FULL);
    expect(summarizeLaneCapacity(lanes().map((l) => l.capacity_status))).toBe("UNAVAILABLE");
  });

  it("REFUSES a non-UNKNOWN status without evidence — and writes nothing", async () => {
    for (const status of ["FULL", "OPEN", "WAITLIST", "CLOSED"]) {
      const r = await call({ event_id: SHEPHERD, capacity_status: status });
      expect(r.isError, status).toBe(true);
      expect(JSON.stringify(r.body)).toContain("capacity_evidence is required");
    }
    expect(lanes()).toHaveLength(0);
    expect(citations()).toHaveLength(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM admin_actions").get()).toEqual({ n: 0 });
  });

  it("UNKNOWN needs no evidence and writes no citation", async () => {
    const r = await call({ event_id: SHEPHERD, capacity_status: "UNKNOWN" });
    expect(r.isError).toBe(false);
    expect(r.body.capacity_citation_id).toBeNull();
    expect(citations()).toHaveLength(0);
  });

  it("a non-capacity patch needs no evidence", async () => {
    const r = await call({ event_id: SHEPHERD, url: "https://example.org/apply" });
    expect(r.isError).toBe(false);
    expect(citations()).toHaveLength(0);
  });

  it("a new claim supersedes the prior one for the same route, and links it", async () => {
    const first = await call(SHEPHERD_FULL);
    const second = await call({
      event_id: SHEPHERD,
      capacity_status: "WAITLIST",
      capacity_evidence: {
        source_url: "https://example.org/waitlist",
        source_type: "official_website",
      },
    });
    const [a, b] = citations();
    expect(a).toMatchObject({ id: first.body.capacity_citation_id, state: "superseded" });
    expect(b).toMatchObject({
      id: second.body.capacity_citation_id,
      state: "active",
      value: "WAITLIST",
      supersedes_citation_id: first.body.capacity_citation_id,
    });
  });

  it("a department's claim never supersedes the whole lane's", async () => {
    await call(SHEPHERD_FULL);
    await call({
      event_id: SHEPHERD,
      department: "Food Court",
      capacity_status: "OPEN",
      capacity_evidence: {
        source_url: "https://example.org/food",
        source_type: "official_website",
      },
    });
    const rows = citations();
    expect(rows.map((r) => [r.field_name, r.state])).toEqual([
      ["vendor_capacity:commercial_vendor", "active"],
      ["vendor_capacity:commercial_vendor:Food Court", "active"],
    ]);
    expect(capacityCitationField("commercial_vendor", null)).toBe(
      "vendor_capacity:commercial_vendor"
    );
  });
});
