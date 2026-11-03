/**
 * OPE-1152 — enrich-on-match staged exactly ONE proposal in its lifetime.
 *
 * Two causes, both pinned here:
 *
 *  1. SCOPE. Fill-empty over image_url / source_url / description only — the
 *     three fields populated first on any event mature enough to be matched.
 *  2. REACH. The stager was wired into ONE match branch (single-event HIGH).
 *     The fan-out, multi-source and multi-URL dedup hits, and the submit
 *     route's own matches (`occurrence_exists`, `possibleDuplicateOf`), all
 *     dropped the email's content with no record. Two of the three specimens
 *     (New Gloucester, Hackmatack) never reached the stager at all.
 *
 * Fixtures are modelled on the three prod specimens. Their extraction output
 * was never persisted, so the extracted shapes are reconstructed from the
 * stored email bodies and the matched events' prod columns (read 2026-10-15).
 *
 * ⚠️ The invariant that must never regress: NOTHING here writes to `events` or
 * `event_days`. Every specimen asserts the matched row is byte-identical after.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";

const harness: { db: TestDb | null } = { db: null };
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: vi.fn(async () => {}) }));

import {
  computeEnrichDisposition,
  stageEnrichOnMatch,
  ENRICH_NOTHING_STAGED_ACTION,
  ENRICH_PROPOSED_ACTION,
} from "../src/email-handlers/enrich-proposal.js";
import { submitEvent } from "../src/email-handlers/submit.js";
import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";
import type { Db } from "../src/db.js";
import type { HandlerEnv } from "../src/email-handlers/types.js";

let raw: ReturnType<typeof createTestDb>["raw"];

beforeEach(() => {
  const t = createTestDb();
  harness.db = t.db;
  raw = t.raw;
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const db = () => harness.db as unknown as Db;

function seedEvent(id: string, cols: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    id,
    name: `Event ${id}`,
    slug: `event-${id}`,
    promoter_id: "p1",
    status: "APPROVED",
    ...cols,
  };
  const keys = Object.keys(row);
  raw
    .prepare(`INSERT INTO events (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...keys.map((k) => row[k] as never));
}
function seedDay(eventId: string, openTime: string | null) {
  raw
    .prepare(`INSERT INTO event_days (id, event_id, date, open_time) VALUES (?,?,?,?)`)
    .run(`d-${eventId}`, eventId, "2026-09-27", openTime);
}
function seedInbound(id: string) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, status, flagged_for_review, created_at) VALUES (?,?,?,?,?,?,0,?)`
    )
    .run(
      id,
      1790000000,
      "organizer@example.com",
      "events@meetmeatthefair.com",
      "submit",
      "processing",
      1790000000
    );
}
const eventRow = (id: string) => raw.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
const daysOf = (id: string) => raw.prepare(`SELECT * FROM event_days WHERE event_id = ?`).all(id);
const actions = () =>
  (
    raw
      .prepare(`SELECT action, target_id, payload_json FROM admin_actions ORDER BY created_at`)
      .all() as Array<{ action: string; target_id: string; payload_json: string }>
  )
    .filter((r) => r.action.startsWith("dedup.enrich"))
    .map((r) => ({ ...r, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
const flagOf = (id: string) =>
  (
    raw.prepare(`SELECT flagged_for_review AS f FROM inbound_emails WHERE id = ?`).get(id) as {
      f: number;
    }
  ).f;

// ── 1. Scope ────────────────────────────────────────────────────────────────

describe("computeEnrichDisposition — widened fill-empty scope", () => {
  it("stages every extractor field the organizer sends when the event has none of it", () => {
    const d = computeEnrichDisposition(
      { description: "Curated.", hasDayHours: false },
      {
        description: "Curated.",
        ticketUrl: "https://t.example/buy",
        ticketPriceMin: 15,
        ticketPriceMax: 100,
        vendorFeeMin: 20,
        vendorFeeMax: 20,
        vendorFeeNotes: "$20 for artisans; non-profits free",
        indoorOutdoor: "OUTDOOR",
        estimatedAttendance: 1800,
        applicationUrl: "https://apply.example",
        applicationDeadline: "2026-09-01",
        applicationInstructions: "Email the organizer.",
        walkInsAllowed: false,
        categories: ["Fair"],
        startTime: "10:00",
        endTime: "15:00",
      }
    );
    expect(d.proposals).toEqual({
      ticket_url: "https://t.example/buy",
      ticket_price_min_cents: 1500,
      ticket_price_max_cents: 10000,
      vendor_fee_min_cents: 2000,
      vendor_fee_max_cents: 2000,
      vendor_fee_notes: "$20 for artisans; non-profits free",
      indoor_outdoor: "OUTDOOR",
      estimated_attendance: 1800,
      application_url: "https://apply.example",
      application_deadline: "2026-09-01",
      application_instructions: "Email the organizer.",
      walk_ins_allowed: false,
      categories: ["Fair"],
      "event_days.hours": { startTime: "10:00", endTime: "15:00" },
    });
    // The same description is not "dropped" content.
    expect(d.unstagedFields).toEqual([]);
  });

  it("never proposes a populated field — it reports it as unstaged instead", () => {
    const d = computeEnrichDisposition(
      { vendorFeeMinCents: 0, vendorFeeNotes: "Per-car pricing ($20/carload).", hasDayHours: true },
      { vendorFeeMin: 20, vendorFeeNotes: "$20 vendor fee for artisans", startTime: "10:00" }
    );
    expect(d.proposals).toEqual({});
    expect(d.unstagedFields.sort()).toEqual(
      ["event_days.hours", "vendor_fee_min_cents", "vendor_fee_notes"].sort()
    );
  });

  it("an empty extraction carries nothing and drops nothing", () => {
    expect(computeEnrichDisposition({}, {})).toEqual({
      proposals: {},
      extractedFields: [],
      unstagedFields: [],
      differing: {},
    });
  });
});

// ── 2. Specimens, through the stager ─────────────────────────────────────────

describe("stageEnrichOnMatch — the three OPE-1152 specimens", () => {
  it("Hackmatack (09eccd4f): vendor terms + hours stage against a keeper with NULL fees", async () => {
    // Keeper 72137786 as in prod: fees NULL, vendor_fee_notes holding the
    // VISITOR per-carload price, no event_days.
    seedEvent("hk", {
      description: "Open Farm Day at Hackmatack Farm + Playhouse.",
      source_url: "https://www.hackmatackplayhouse.org/",
      ticket_price_min_cents: 2000,
      ticket_price_max_cents: 2000,
      vendor_fee_notes:
        "Per-car pricing ($20/carload). Craft + Community Fair vendor applications via the site.",
      indoor_outdoor: "OUTDOOR",
      estimated_attendance: 1000,
      application_url: "https://www.hackmatackplayhouse.org/farm-day-vendor",
    });
    seedInbound("09eccd4f");
    const before = eventRow("hk");

    const out = await stageEnrichOnMatch(db(), {
      existingEventId: "hk",
      url: "",
      event: {
        name: "Hackmatack Open Farm Day",
        startDate: "2026-06-21",
        startTime: "10:00",
        endTime: "15:00",
        hoursNotes: "Vendor set-up 8:30–9:30",
        vendorFeeMin: 20,
        vendorFeeMax: 20,
        vendorFeeNotes:
          "$20 vendor fee for artisans, no fee for community non-profits. Payment day-of. Bring a 10x10 tent, table and weights.",
      },
      matchType: "possible_duplicate",
      path: "possible-duplicate",
      inboundEmailId: "09eccd4f",
      fromAddress: "heathdesk@hackmatack.org",
    });

    expect(out.outcome).toBe("proposed");
    const [row] = actions();
    expect(row.action).toBe(ENRICH_PROPOSED_ACTION);
    expect(row.target_id).toBe("hk");
    expect(row.payload.proposals).toEqual({
      vendor_fee_min_cents: 2000,
      vendor_fee_max_cents: 2000,
      "event_days.hours": {
        startTime: "10:00",
        endTime: "15:00",
        hoursNotes: "Vendor set-up 8:30–9:30",
      },
    });
    // The mis-filed visitor price is NOT overwritten — it is named for a human.
    expect(row.payload.unstagedFields).toEqual(["vendor_fee_notes"]);
    expect(flagOf("09eccd4f")).toBe(1);
    expect(eventRow("hk")).toEqual(before);
    expect(daysOf("hk")).toEqual([]);
  });

  it("New Gloucester (9fc287ef): attendance + hours stage against the series edition", async () => {
    // 4fde2cf7 as created 2026-08-20 from the town rec page, before the
    // 09-11 hand-apply: no attendance, no hours.
    seedEvent("ng", {
      description: "New Gloucester Community Fair at the Fairgrounds.",
      source_url: "https://grayme.myrec.com/info/activities/program_details.aspx?ProgramID=29686",
      ticket_url: "https://grayme.myrec.com/info/activities/program_details.aspx?ProgramID=29686",
      indoor_outdoor: "OUTDOOR",
      categories: '["Community Event","Fair"]',
    });
    seedDay("ng", null);
    seedInbound("9fc287ef");
    const before = eventRow("ng");

    await stageEnrichOnMatch(db(), {
      existingEventId: "ng",
      url: "",
      event: {
        name: "New Gloucester Community Fair",
        startDate: "2026-09-12",
        startTime: "09:00",
        endTime: "16:00",
        estimatedAttendance: 1800,
        indoorOutdoor: "OUTDOOR",
        categories: ["Fair"],
      },
      matchType: "occurrence_exists",
      path: "occurrence-exists",
      inboundEmailId: "9fc287ef",
      fromAddress: "carolyn@example.com",
    });

    const [row] = actions();
    expect(row.action).toBe(ENRICH_PROPOSED_ACTION);
    expect(row.payload.proposals).toEqual({
      estimated_attendance: 1800,
      "event_days.hours": { startTime: "09:00", endTime: "16:00" },
    });
    // OUTDOOR and "Fair" are already on the event: carried, not dropped.
    expect(row.payload.unstagedFields).toEqual([]);
    expect(flagOf("9fc287ef")).toBe(1);
    expect(eventRow("ng")).toEqual(before);
    expect(daysOf("ng")).toHaveLength(1);
  });

  it("Pemaquid (9e5b0816): a mature event stages nothing — and that is now RECORDED and flagged", async () => {
    // 4acb8bbe: every fillable field the JSON-LD carries is already set. The
    // value in the organizer's page (accessibility, the oyster-ticket mechanic,
    // the bands) is prose inside a description we already hold.
    seedEvent("pq", {
      description: "The Pemaquid Oyster Festival returns to Damariscotta.",
      source_url: "https://pemaquidoysterfestival.com/",
      image_url: "https://cdn.example/pemaquid.webp",
      ticket_url: "https://www.eventcreate.com/e/pemaquid-oyster-festival",
      ticket_price_min_cents: 1500,
      ticket_price_max_cents: 10000,
      indoor_outdoor: "MIXED",
      categories: '["Festival","Food Festival"]',
    });
    seedDay("pq", "11:00");
    seedInbound("9e5b0816");
    const before = eventRow("pq");

    const out = await stageEnrichOnMatch(db(), {
      existingEventId: "pq",
      url: "https://www.eventcreate.com/e/pemaquid-oyster-festival",
      event: {
        name: "Pemaquid Oyster Festival",
        startDate: "2026-09-27",
        description:
          "The first floor is fully accessible. One ticket is good for 3 oysters from one farm. $500 prize for the shucking contest. Four bands across two stages.",
        imageUrl: "https://www.eventcreate.com/img/pemaquid-hero.jpg",
        ticketUrl: "https://www.eventcreate.com/e/pemaquid-oyster-festival",
        ticketPriceMin: 15,
        ticketPriceMax: 100,
        startTime: "11:00",
      },
      matchType: "venue_date",
      path: "single-high",
      inboundEmailId: "9e5b0816",
      fromAddress: "john@pimboat.com",
    });

    expect(out.outcome).toBe("nothing-staged");
    const [row] = actions();
    expect(row.action).toBe(ENRICH_NOTHING_STAGED_ACTION);
    expect(row.payload.proposals).toBeUndefined();
    expect((row.payload.unstagedFields as string[]).sort()).toEqual(
      ["description", "event_days.hours", "image_url", "source_url"].sort()
    );
    expect(row.payload.extractedFields).toContain("ticket_price_min_cents");
    // Before OPE-1152 this row stayed 0 and nothing was written anywhere.
    expect(flagOf("9e5b0816")).toBe(1);
    expect(eventRow("pq")).toEqual(before);
  });

  it("a match whose email carries only what the event already says is recorded but NOT flagged", async () => {
    seedEvent("same", { description: "Same words.", indoor_outdoor: "OUTDOOR" });
    seedInbound("in-same");
    await stageEnrichOnMatch(db(), {
      existingEventId: "same",
      url: "",
      event: { name: "x", description: "Same words.", indoorOutdoor: "OUTDOOR" },
      matchType: "venue_date",
      path: "single-high",
      inboundEmailId: "in-same",
      fromAddress: null,
    });
    const [row] = actions();
    expect(row.action).toBe(ENRICH_NOTHING_STAGED_ACTION);
    expect(row.payload.unstagedFields).toEqual([]);
    expect(flagOf("in-same")).toBe(0);
  });
});

// ── 3. Reach: the submit route's own matches ─────────────────────────────────

describe("submitEvent — the submit route's matches now reach the stager", () => {
  const ENV: HandlerEnv = {
    DB: {} as unknown as D1Database,
    MAIN_APP_URL: "https://app.test",
    INTERNAL_API_KEY: "k",
  };
  const extracted = (event: Record<string, unknown>) =>
    ({
      url: "",
      event: { name: "New Gloucester Community Fair", startDate: "2026-09-12", ...event },
      extractionMethod: "free-text",
      totalEventsDetected: 1,
      additionalEventNames: [],
      events: [],
    }) as never;

  it("occurrence_exists (New Gloucester) stages against the existing edition", async () => {
    seedEvent("ng", { description: "Fair." });
    seedInbound("9fc287ef");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: true, routed: "occurrence_exists", event: { id: "ng" } })
      )
    );
    await submitEvent(ENV, extracted({ estimatedAttendance: 1800 }), "c@example.com", {
      inboundEmailId: "9fc287ef",
      dedupWasBlind: false,
      sourceTexts: [],
    });
    const [row] = actions();
    expect(row.target_id).toBe("ng");
    expect(row.payload.path).toBe("occurrence-exists");
    expect(row.payload.proposals).toEqual({ estimated_attendance: 1800 });
  });

  it("possibleDuplicateOf (Hackmatack) stages against the CANDIDATE, not the new twin", async () => {
    seedEvent("hk", { description: "Farm day." });
    seedInbound("09eccd4f");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          event: { id: "twin", slug: "twin" },
          possibleDuplicateOf: "hk",
        })
      )
    );
    await submitEvent(ENV, extracted({ vendorFeeMin: 20 }), "a@example.com", {
      inboundEmailId: "09eccd4f",
      dedupWasBlind: false,
      sourceTexts: [],
    });
    const [row] = actions();
    expect(row.target_id).toBe("hk");
    expect(row.payload.path).toBe("possible-duplicate");
    expect(row.payload.proposals).toEqual({ vendor_fee_min_cents: 2000 });
  });

  it("a plain create with no match stages nothing", async () => {
    seedInbound("plain");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, event: { id: "new", slug: "new" } }))
    );
    await submitEvent(ENV, extracted({ vendorFeeMin: 20 }), "a@example.com", {
      inboundEmailId: "plain",
      dedupWasBlind: false,
      sourceTexts: [],
    });
    expect(actions()).toEqual([]);
  });
});

// ── 4. Reach: every workflow dedup-hit branch ────────────────────────────────

function makeWorkflow() {
  const env = {
    DB: {} as unknown as D1Database,
    MAIN_APP_URL: "https://app.test",
    INTERNAL_API_KEY: "k",
    EMAIL: undefined,
  };
  return new (InboundEmailWorkflow as unknown as new (
    ctx: unknown,
    env: unknown
  ) => {
    runSubmitPipeline: (step: unknown, id: string) => Promise<{ replyKind: string | null }>;
  })({}, env);
}

function makeStep(row: Record<string, unknown>) {
  return {
    do: async (label: string, optsOrFn: unknown, maybeFn?: unknown) => {
      if (label === "submit/load-row") return row;
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return await fn();
    },
  };
}

const futureDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Every check-duplicate is a HIGH venue_date hit on `ev-<name>`. */
function installMatchingFetch(urlEvents: Record<string, Array<Record<string, unknown>>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const body =
        init && typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      if (u.pathname === "/api/admin/import-url/fetch") {
        const target = u.searchParams.get("url") ?? "";
        const dates = (urlEvents[target] ?? []).map((e) => e.startDate).join(" ");
        return Response.json({ success: true, content: `PAGE ${target} ${dates}` });
      }
      if (u.pathname === "/api/admin/import-url/extract") {
        const events = urlEvents[String(body.url ?? "")] ?? [];
        return Response.json({
          success: true,
          events,
          count: events.length,
          extractionMethod: "ai",
        });
      }
      if (u.pathname === "/api/suggest-event/check-duplicate") {
        const id = `ev-${String(body.name).toLowerCase().replace(/\s+/g, "-")}`;
        return Response.json({
          success: true,
          isDuplicate: true,
          matchType: "venue_date",
          existingEvent: { id, slug: id, name: String(body.name), status: "APPROVED" },
        });
      }
      if (u.pathname === "/api/suggest-event/submit") throw new Error("must not create");
      return Response.json({ success: true });
    })
  );
}

describe("InboundEmailWorkflow — every dedup-hit branch stages (it used to be ONE)", () => {
  const rich = (name: string, days: number) => ({
    name,
    startDate: futureDate(days),
    vendorFeeMin: 20,
    estimatedAttendance: 900,
  });

  it("single-URL HIGH match → path single-high", async () => {
    seedEvent("ev-solo-fair", { description: "x" });
    seedInbound("row-1");
    installMatchingFetch({ "https://ex.test/a": [rich("Solo Fair", 40)] });
    const res = await makeWorkflow().runSubmitPipeline(
      makeStep({
        parsedUrl: "https://ex.test/a",
        fromAddress: "o@example.com",
        subject: "Solo",
        attachmentCount: 0,
        classifiedSubIntent: "new_event",
        bodyTextExcerpt: "https://ex.test/a",
      }),
      "row-1"
    );
    expect(res.replyKind).toBe("already-exists");
    expect(actions().map((a) => [a.target_id, a.payload.path])).toEqual([
      ["ev-solo-fair", "single-high"],
    ]);
  });

  it("one page, two events, both matched → path multi-source, one row each", async () => {
    seedEvent("ev-june-day", { description: "x" });
    seedEvent("ev-fall-fest", { description: "x" });
    seedInbound("row-1");
    installMatchingFetch({
      "https://ex.test/farm": [rich("June Day", 40), rich("Fall Fest", 150)],
    });
    await makeWorkflow().runSubmitPipeline(
      makeStep({
        parsedUrl: "https://ex.test/farm",
        fromAddress: "o@example.com",
        subject: "Farm days",
        attachmentCount: 0,
        classifiedSubIntent: "new_event",
        bodyTextExcerpt: "https://ex.test/farm",
      }),
      "row-1"
    );
    const rows = actions();
    expect(rows.map((a) => [a.target_id, a.payload.path]).sort()).toEqual([
      ["ev-fall-fest", "multi-source"],
      ["ev-june-day", "multi-source"],
    ]);
    expect(rows.every((r) => r.action === ENRICH_PROPOSED_ACTION)).toBe(true);
    expect(flagOf("row-1")).toBe(1);
  });

  it("free-text body, two events, both matched → path fanout (the Hackmatack email shape)", async () => {
    seedEvent("ev-june-day", { description: "x" });
    seedEvent("ev-fall-fest", { description: "x" });
    seedInbound("row-1");
    const june = rich("June Day", 40);
    const fall = rich("Fall Fest", 150);
    installMatchingFetch({ "": [june, fall] });
    await makeWorkflow().runSubmitPipeline(
      makeStep({
        parsedUrl: null,
        fromAddress: "o@example.com",
        subject: "Farm days",
        attachmentCount: 0,
        classifiedSubIntent: "free_text",
        bodyTextExcerpt: `Our June Day is ${june.startDate} and Fall Fest is ${fall.startDate}. There is a $20 vendor fee for artisans. About 900 visitors.`,
      }),
      "row-1"
    );
    const rows = actions();
    expect(rows.map((a) => [a.target_id, a.payload.path]).sort()).toEqual([
      ["ev-fall-fest", "fanout"],
      ["ev-june-day", "fanout"],
    ]);
    expect(rows[0].payload.proposals).toEqual({
      vendor_fee_min_cents: 2000,
      estimated_attendance: 900,
    });
  });

  it("two URLs, both matched → a disposition row per URL (multi-url / multi-source)", async () => {
    seedEvent("ev-north-fair", { description: "x" });
    seedEvent("ev-south-fair", { description: "x" });
    seedInbound("row-1");
    installMatchingFetch({
      "https://ex.test/n": [rich("North Fair", 40)],
      "https://ex.test/s": [rich("South Fair", 80)],
    });
    await makeWorkflow().runSubmitPipeline(
      makeStep({
        parsedUrl: "https://ex.test/n",
        fromAddress: "o@example.com",
        subject: "Two fairs",
        attachmentCount: 0,
        classifiedSubIntent: "multi_url",
        bodyTextExcerpt: "https://ex.test/n and https://ex.test/s",
      }),
      "row-1"
    );
    const rows = actions();
    expect(rows.map((a) => a.target_id).sort()).toEqual(["ev-north-fair", "ev-south-fair"]);
    // Body URLs route to the multi-source pipeline (shouldFanOut) before the
    // legacy multi-URL branch is considered.
    expect(rows.every((r) => r.payload.path === "multi-source")).toBe(true);
  });

  it("the legacy multi-URL pipeline stages too → path multi-url", async () => {
    // Only reachable from runSubmitPipeline when the body yields no URL that
    // the multi-source gate accepts, so it is driven directly.
    seedEvent("ev-north-fair", { description: "x" });
    seedEvent("ev-south-fair", { description: "x" });
    seedInbound("row-1");
    installMatchingFetch({
      "https://ex.test/n": [rich("North Fair", 40)],
      "https://ex.test/s": [rich("South Fair", 80)],
    });
    const wf = makeWorkflow() as unknown as {
      runMultiUrlPipeline: (...a: unknown[]) => Promise<unknown>;
    };
    await wf.runMultiUrlPipeline(
      makeStep({}),
      ["https://ex.test/n", "https://ex.test/s"],
      "Two fairs",
      "o@example.com",
      false,
      false,
      "row-1",
      ""
    );
    expect(
      actions()
        .map((a) => [a.target_id, a.payload.path])
        .sort()
    ).toEqual([
      ["ev-north-fair", "multi-url"],
      ["ev-south-fair", "multi-url"],
    ]);
  });
});
