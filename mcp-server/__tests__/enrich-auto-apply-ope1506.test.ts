/**
 * OPE-1506 — enrich-on-match auto-applies to EMPTY fields for trusted senders
 * and verified organizers (John's ruling, 2026-10-20), and stays stage-only for
 * everyone else.
 *
 * Each acceptance fixture from the ticket runs `stageEnrichOnMatch` for real
 * against the test schema, and asserts the event row, the citation rows and the
 * audit row — the three things a reviewer would check by hand.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  adminActions,
  eventDataCitations,
  eventDays,
  events,
  inboundEmails,
  inboundEmailSenders,
  promoterContacts,
  promoters,
} from "../src/schema.js";
import {
  stageEnrichOnMatch,
  ENRICH_PROPOSED_ACTION,
} from "../src/email-handlers/enrich-proposal.js";
import {
  ENRICH_APPLIED_ACTION,
  isUnambiguousMatch,
} from "../src/email-handlers/enrich-auto-apply.js";
import { findVisitorFacts } from "@takemetothefair/utils";

let db: TestDb;
const NOW = new Date("2026-10-14T22:44:00Z");

function seedPromoter(id: string, website: string | null) {
  db.insert(promoters)
    .values({ id, companyName: id, slug: id, website, claimed: false } as never)
    .run();
}

function seedEvent(id: string, promoterId: string, extra: Record<string, unknown> = {}) {
  db.insert(events)
    .values({
      id,
      name: id,
      slug: id,
      status: "APPROVED",
      lifecycleStatus: "SCHEDULED",
      promoterId,
      startDate: new Date("2026-10-24T00:00:00Z"),
      endDate: new Date("2026-10-24T00:00:00Z"),
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    } as never)
    .run();
  db.insert(eventDays)
    .values({ id: `${id}-d1`, eventId: id, date: "2026-10-24" } as never)
    .run();
}

function seedInbound(id: string, from: string, senderAuth: string | null) {
  db.insert(inboundEmails)
    .values({
      id,
      receivedAt: NOW,
      fromAddress: from,
      toAddress: "submit@meetmeatthefair.com",
      subject: "Fwd: fair",
      intent: "submit",
      status: "received",
      senderAuth,
      createdAt: NOW,
    } as never)
    .run();
}

function trust(email: string) {
  db.insert(inboundEmailSenders)
    .values({ email, trustStatus: "trusted", createdAt: NOW, updatedAt: NOW } as never)
    .run();
}

const event = (id: string) => db.select().from(events).where(eq(events.id, id)).get()!;
const actions = (action: string) =>
  db.select().from(adminActions).where(eq(adminActions.action, action)).all();
const citations = (eventId: string) =>
  db
    .select()
    .from(eventDataCitations)
    .where(and(eq(eventDataCitations.eventId, eventId), eq(eventDataCitations.state, "active")))
    .all();

const stage = (over: Record<string, unknown>) =>
  stageEnrichOnMatch(
    db as never,
    {
      existingEventId: "ev",
      url: null,
      event: {},
      matchType: "exact_url",
      path: "single-high",
      inboundEmailId: "in-1",
      fromAddress: null,
      ...over,
    } as never
  );

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("OPE-1506 — acceptance fixtures", () => {
  it("Hackmatack shape (organizer DMARC-aligned to the promoter's own domain): vendor fee + hours applied, cited", async () => {
    seedPromoter("hack", "https://www.hackmatackplayhouse.org/");
    seedEvent("ev", "hack");
    seedInbound("in-1", "boxoffice@hackmatackplayhouse.org", "pass");
    const r = await stage({ event: { vendorFeeMin: 50, startTime: "10:00", endTime: "16:00" } });

    expect(r.applied).toEqual(expect.arrayContaining(["vendor_fee_min_cents", "event_days.hours"]));
    expect(event("ev").vendorFeeMinCents).toBe(5000);
    const day = db.select().from(eventDays).where(eq(eventDays.eventId, "ev")).get()!;
    expect([day.openTime, day.closeTime]).toEqual(["10:00", "16:00"]);
    const cites = citations("ev");
    expect(cites.map((c) => c.fieldName).sort()).toEqual(["hours", "vendor_fee_min"]);
    expect(cites.find((c) => c.fieldName === "vendor_fee_min")).toMatchObject({
      value: "50.00",
      sourceType: "user_submitted",
      sourceUrl: "https://meetmeatthefair.com/admin/inbound-emails#in-1",
    });
    const [audit] = actions(ENRICH_APPLIED_ACTION);
    expect(JSON.parse(audit.payloadJson!)).toMatchObject({
      basis: "dmarc-aligned",
      inboundEmailId: "in-1",
      fields: expect.arrayContaining([
        expect.objectContaining({ field: "vendor_fee_min_cents", old: null, new: 5000 }),
      ]),
    });
  });

  it("New Gloucester shape (Carolyn, trusted): attendance + hours applied", async () => {
    seedPromoter("ng", "https://newgloucester.com");
    seedEvent("ev", "ng");
    seedInbound("in-1", "carolyn@example.com", "pass");
    trust("carolyn@example.com");
    const r = await stage({
      event: { estimatedAttendance: 2000, startTime: "09:00", endTime: "15:00" },
    });
    expect(r.applied).toEqual(expect.arrayContaining(["estimated_attendance", "event_days.hours"]));
    expect(event("ev").estimatedAttendance).toBe(2000);
    expect(JSON.parse(actions(ENRICH_APPLIED_ACTION)[0].payloadJson!).basis).toBe("trusted");
  });

  it("Manchester Grange shape (John's forward, text match, extraction failed): accessibility + parking applied with verbatim excerpts", async () => {
    seedPromoter("mg", null);
    seedEvent("ev", "mg");
    seedInbound("in-1", "john@example.com", "pass");
    trust("john@example.com");
    const body =
      "The fair goes from 8am to 2pm. There is a ramp at the back of the building which may be easier to use than the front of the building which has stairs. On the day of the craft fair, if you are able, we ask that you move your vehicle to the upper parking lot to allow customers to park in the Grange lot.";
    const r = await stage({
      path: "text-match",
      matchType: "text_match",
      event: { visitorFacts: findVisitorFacts(body) },
    });
    expect(r.applied).toEqual(expect.arrayContaining(["accessibility_notes", "parking_notes"]));
    expect(event("ev").accessibilityNotes).toMatch(/^There is a ramp at the back of the building/);
    expect(event("ev").parkingNotes).toMatch(/park in the Grange lot\.$/);
    const access = citations("ev").find((c) => c.fieldName === "accessibility_notes")!;
    expect(access.sourceExcerpt).toBe(event("ev").accessibilityNotes);
  });

  it("an UNKNOWN sender with the same content stages and applies nothing", async () => {
    seedPromoter("hack", "https://www.hackmatackplayhouse.org/");
    seedEvent("ev", "hack");
    seedInbound("in-1", "someone@example.net", "pass");
    const r = await stage({ event: { vendorFeeMin: 50, startTime: "10:00", endTime: "16:00" } });
    expect(r.applied).toEqual([]);
    expect(event("ev").vendorFeeMinCents).toBeNull();
    expect(actions(ENRICH_APPLIED_ACTION)).toHaveLength(0);
    const [staged] = actions(ENRICH_PROPOSED_ACTION);
    const payload = JSON.parse(staged.payloadJson!);
    expect(Object.keys(payload.proposals)).toEqual(
      expect.arrayContaining(["vendor_fee_min_cents", "event_days.hours"])
    );
    expect(payload.autoApply).toMatchObject({ basis: null });
  });

  it("a field already holding a DIFFERENT value is never overwritten, and is listed in unstagedFields", async () => {
    seedPromoter("ng", null);
    seedEvent("ev", "ng", { estimatedAttendance: 900 });
    seedInbound("in-1", "carolyn@example.com", "pass");
    trust("carolyn@example.com");
    const r = await stage({ event: { estimatedAttendance: 2000 } });
    expect(event("ev").estimatedAttendance).toBe(900);
    expect(r.applied).toEqual([]);
    expect(r.disposition.unstagedFields).toContain("estimated_attendance");
  });

  it("a validated contact of promoter A, matched to promoter B's event, applies nothing", async () => {
    seedPromoter("A", null);
    seedPromoter("B", null);
    seedEvent("ev", "B");
    seedInbound("in-1", "chair@a-fair.org", "pass");
    db.insert(promoterContacts)
      .values({
        id: "pc-1",
        promoterId: "A",
        email: "chair@a-fair.org",
        validationMethod: "replied_to_our_mail",
        status: "validated",
        createdAt: NOW,
        updatedAt: NOW,
      } as never)
      .run();
    const r = await stage({ event: { vendorFeeMin: 50 } });
    expect(r.applied).toEqual([]);
    expect(event("ev").vendorFeeMinCents).toBeNull();
  });

  it("…while the same contact matched to ITS OWN promoter's event does apply (positive control)", async () => {
    seedPromoter("A", null);
    seedEvent("ev", "A");
    seedInbound("in-1", "chair@a-fair.org", "pass");
    db.insert(promoterContacts)
      .values({
        id: "pc-1",
        promoterId: "A",
        email: "chair@a-fair.org",
        validationMethod: "replied_to_our_mail",
        status: "validated",
        createdAt: NOW,
        updatedAt: NOW,
      } as never)
      .run();
    const r = await stage({ event: { vendorFeeMin: 50 } });
    expect(r.applied).toEqual(["vendor_fee_min_cents"]);
    expect(JSON.parse(actions(ENRICH_APPLIED_ACTION)[0].payloadJson!).basis).toBe(
      "verified-contact"
    );
  });
});

describe("OPE-1506 — the predicate's other guards", () => {
  it("a TRUSTED address without an aligned DMARC pass applies nothing (From is spoofable)", async () => {
    seedPromoter("ng", null);
    seedEvent("ev", "ng");
    seedInbound("in-1", "carolyn@example.com", "partial");
    trust("carolyn@example.com");
    const r = await stage({ event: { estimatedAttendance: 2000 } });
    expect(r.applied).toEqual([]);
    expect(event("ev").estimatedAttendance).toBeNull();
  });

  it("an ambiguous (fuzzy venue/date) match stays staged even from a trusted sender", async () => {
    seedPromoter("ng", null);
    seedEvent("ev", "ng");
    seedInbound("in-1", "carolyn@example.com", "pass");
    trust("carolyn@example.com");
    const r = await stage({ matchType: "venue_date", event: { estimatedAttendance: 2000 } });
    expect(r.applied).toEqual([]);
    expect(isUnambiguousMatch("single-high", "venue_date")).toBe(false);
    expect(isUnambiguousMatch("possible-duplicate", null)).toBe(false);
    expect(isUnambiguousMatch("occurrence-exists", null)).toBe(true);
  });

  it("never-auto fields stay staged: description, categories, image, source_url", async () => {
    seedPromoter("ng", null);
    seedEvent("ev", "ng");
    seedInbound("in-1", "carolyn@example.com", "pass");
    trust("carolyn@example.com");
    const r = await stage({
      url: "https://ng.example.org/fair",
      event: {
        description: "A fair.",
        categories: ["Craft Fair"],
        imageUrl: "https://ng.example.org/poster.jpg",
        estimatedAttendance: 2000,
      },
    });
    expect(r.applied).toEqual(["estimated_attendance"]);
    const e = event("ev");
    expect([e.description, e.imageUrl, e.sourceUrl]).toEqual([null, null, null]);
    const payload = JSON.parse(actions(ENRICH_PROPOSED_ACTION)[0].payloadJson!);
    expect(Object.keys(payload.proposals).sort()).toEqual(
      ["categories", "description", "image_url", "source_url"].sort()
    );
  });

  it("per-day hours are not guessed: a dayHours proposal stays staged", async () => {
    seedPromoter("ng", null);
    seedEvent("ev", "ng");
    seedInbound("in-1", "carolyn@example.com", "pass");
    trust("carolyn@example.com");
    const r = await stage({
      event: {
        startTime: "10:00",
        endTime: "16:00",
        dayHours: [{ date: "2026-10-24", open: "09:00" }],
      },
    });
    expect(r.applied).toEqual([]);
    const day = db.select().from(eventDays).where(eq(eventDays.eventId, "ev")).get()!;
    expect(day.openTime).toBeNull();
  });

  it("the audit row and the staged row both record the verdict (the probe's demand + evidence)", async () => {
    seedPromoter("ng", null);
    seedEvent("ev", "ng");
    seedInbound("in-1", "carolyn@example.com", "pass");
    trust("carolyn@example.com");
    await stage({ event: { estimatedAttendance: 2000, description: "A fair." } });
    const staged = JSON.parse(actions(ENRICH_PROPOSED_ACTION)[0].payloadJson!);
    expect(staged.autoApply).toMatchObject({
      basis: "trusted",
      eligible: ["estimated_attendance"],
      applied: ["estimated_attendance"],
    });
    expect(actions(ENRICH_APPLIED_ACTION)).toHaveLength(1);
  });
});

describe("OPE-1506 — the write itself re-checks emptiness (a field filled meanwhile)", () => {
  it("applyEmptyFields never overwrites a column that is no longer empty", async () => {
    const { applyEmptyFields } = await import("../src/email-handlers/enrich-auto-apply.js");
    seedPromoter("ng", null);
    seedEvent("ev", "ng", { estimatedAttendance: 900, petFriendly: "NO" });
    seedInbound("in-1", "carolyn@example.com", "pass");
    // The proposal was computed when the field was empty; a human filled it since.
    const r = await applyEmptyFields(db as never, {
      eventId: "ev",
      proposals: {
        estimated_attendance: 2000,
        pet_friendly: { value: "YES", excerpt: "Leashed dogs are welcome." },
      },
      inboundEmailId: "in-1",
      receivedAt: NOW,
    });
    expect(r.applied).toEqual([]);
    expect(Object.keys(r.notApplied).sort()).toEqual(["estimated_attendance", "pet_friendly"]);
    expect(event("ev").estimatedAttendance).toBe(900);
    expect(event("ev").petFriendly).toBe("NO");
    expect(citations("ev")).toHaveLength(0);
  });
});
