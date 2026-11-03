/**
 * OPE-1290 — an imminent public event on a venue with no map pin reaches the
 * operator. Seeds real rows and runs `readOperatorQueues` against SQLite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./setup-db.js";
import {
  readOperatorQueues,
  decideOperatorQueueNotice,
  parseRefusal,
  UNPINNED_IMMINENT_DAYS,
} from "../src/operator-queue-notice.js";

const NOW = new Date("2026-10-04T18:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const DAY = 86400;

let db: ReturnType<typeof createTestDb>["db"];
let raw: ReturnType<typeof createTestDb>["raw"];

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw["prepare"](`INSERT INTO promoters (id, company_name, slug) VALUES ('p1','P','p')`).run();
});

function venue(id: string, opts: { lat?: number | null; status?: string; refusals?: number } = {}) {
  raw["prepare"](
    `INSERT INTO venues (id, name, slug, city, state, latitude, status, geocode_refusals)
     VALUES (?, ?, ?, 'Freeport', 'ME', ?, ?, ?)`
  ).run(
    id,
    `Venue ${id}`,
    `venue-${id}`,
    opts.lat ?? null,
    opts.status ?? "ACTIVE",
    opts.refusals ?? 0
  );
}
function event(slug: string, venueId: string, startOffsetDays: number, status = "APPROVED") {
  raw["prepare"](
    `INSERT INTO events (id, name, slug, promoter_id, venue_id, status, start_date, end_date)
     VALUES (?, ?, ?, 'p1', ?, ?, ?, ?)`
  ).run(
    `e-${slug}`,
    slug,
    slug,
    venueId,
    status,
    nowSec + startOffsetDays * DAY,
    nowSec + startOffsetDays * DAY
  );
}
function refusal(venueId: string, payload: Record<string, unknown>) {
  raw["prepare"](
    `INSERT INTO admin_actions (id, action, target_type, target_id, payload_json, created_at)
     VALUES (?, 'venue.geocode.refused', 'venue', ?, ?, ?)`
  ).run(`a-${venueId}-${Math.random()}`, venueId, JSON.stringify(payload), nowSec);
}

describe("OPE-1290 — imminent event on an unpinned venue", () => {
  it("SPECIMEN shape: an APPROVED event in 2 days on an unpinned venue is flagged, with the gate's verdict and candidate", async () => {
    venue("hgi", { refusals: 2 });
    refusal("hgi", {
      status: "low-confidence",
      reason: "2 candidates",
      candidate: "5 Park St, Freeport, ME 04032, USA",
    });
    event("hilton-garden-inn-event", "hgi", 2);
    const q = await readOperatorQueues(db, NOW);
    expect(q.unpinnedVenueImminent).toBe(1);
    const line = q.lines.find((l) => l.includes("hilton-garden-inn-event"))!;
    expect(line).toContain("venue has no map pin");
    expect(line).toContain("gate: low-confidence (2 candidates)");
    expect(line).toContain("Google's candidate: 5 Park St, Freeport, ME 04032, USA");
    expect(line).toContain("sweep refusals: 2");
    expect(decideOperatorQueueNotice(q, false)).toBe(true);
  });

  it("the SAME event on a PINNED venue is not flagged (pinned from both sides)", async () => {
    venue("pinned", { lat: 43.85 });
    event("pinned-event", "pinned", 2);
    const q = await readOperatorQueues(db, NOW);
    expect(q.unpinnedVenueImminent).toBe(0);
    expect(q.unpinnedVenueExamined).toBe(1); // landmark: it WAS examined
  });

  it("excludes a venue the gate calls not-a-point", async () => {
    venue("trail");
    refusal("trail", { status: "not-a-point", reason: "statewide", candidate: null });
    event("on-trail", "trail", 1);
    const q = await readOperatorQueues(db, NOW);
    expect(q.unpinnedVenueImminent).toBe(0);
    expect(q.unpinnedVenueExamined).toBe(1);
  });

  it("excludes FORMER venues (pinned by source: OPE-1180's triggers make that row unbuildable)", async () => {
    // FORMER_VENUE_AFTER_CLOSURE refuses a new event on a closed venue, and
    // FORMER_VENUE_HAS_LATER_EVENTS refuses closing a venue with later events,
    // so no fixture can hold an upcoming event on a FORMER venue. The clause is
    // defence in depth; pin it in the query itself.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../src/operator-queue-notice.ts", import.meta.url), "utf8");
    expect(src).toMatch(/AND v\.latitude IS NULL\s+AND v\.status <> 'FORMER'/);
  });

  it(`only events starting within ${UNPINNED_IMMINENT_DAYS} days, and only APPROVED/TENTATIVE`, async () => {
    venue("v");
    event("far-away", "v", UNPINNED_IMMINENT_DAYS + 3);
    event("pending-one", "v", 2, "PENDING");
    event("tentative-one", "v", 3, "TENTATIVE");
    const q = await readOperatorQueues(db, NOW);
    expect(q.unpinnedVenueImminent).toBe(1);
    expect(q.lines.some((l) => l.includes("tentative-one"))).toBe(true);
    expect(q.unpinnedVenueExamined).toBe(1);
  });

  it("zero state stays silent", async () => {
    const q = await readOperatorQueues(db, NOW);
    expect(q.unpinnedVenueImminent).toBe(0);
    expect(decideOperatorQueueNotice(q, false)).toBe(false);
  });
});

describe("parseRefusal", () => {
  it("reads the #1513 payload and rejects junk", () => {
    expect(parseRefusal('{"status":"no-match","reason":null,"candidate":null}')).toEqual({
      status: "no-match",
      reason: null,
      candidate: null,
    });
    expect(parseRefusal("not json")).toBeNull();
    expect(parseRefusal('{"reason":"x"}')).toBeNull();
    expect(parseRefusal(null)).toBeNull();
  });
});
