import { describe, it, expect } from "vitest";
import {
  evaluateOutreachReasons,
  classifyContact,
  buildOutreachQueueRow,
  PLACEHOLDER_PROMOTER_NAME,
  type OutreachCandidateInput,
} from "./promoter-outreach-queue";

const NOW = new Date("2026-08-31T00:00:00Z");

const healthy = (over: Partial<OutreachCandidateInput> = {}): OutreachCandidateInput => ({
  startDate: new Date("2026-10-01T12:00:00Z"),
  datesConfirmed: true,
  dateCitationCount: 2,
  tags: [],
  lifecycleStatus: "SCHEDULED",
  eventDayCount: 2,
  commercialVendorsAllowed: false,
  vendorApplicationUrl: null,
  promoterName: "Dartmouth Grange #162",
  promoterContactEmail: "info@dartmouthgrange.org",
  ...over,
});

describe("evaluateOutreachReasons (OPE-384 stage 2)", () => {
  it("returns nothing for a fully-confirmed future event", () => {
    expect(evaluateOutreachReasons(healthy(), NOW)).toEqual([]);
  });

  it("flags an event whose dates were never confirmed", () => {
    expect(evaluateOutreachReasons(healthy({ datesConfirmed: false }), NOW)).toContain(
      "dates_unconfirmed"
    );
  });

  it("flags CONFIRMED dates with no citation — the Dartmouth shape", () => {
    // The whole point. `dates_confirmed = true` says somebody decided; zero
    // citations says nobody could show why. A queue that trusted the flag
    // would skip exactly the events most worth asking about.
    const r = evaluateOutreachReasons(healthy({ datesConfirmed: true, dateCitationCount: 0 }), NOW);
    expect(r).toContain("dates_confirmed_uncited");
    expect(r).not.toContain("dates_unconfirmed");
  });

  it("does not double-count unconfirmed and uncited", () => {
    // An unconfirmed event is trivially uncited; reporting both would inflate
    // the reason list and read as two problems.
    const r = evaluateOutreachReasons(
      healthy({ datesConfirmed: false, dateCitationCount: 0 }),
      NOW
    );
    expect(r.filter((x) => x.startsWith("dates_"))).toEqual(["dates_unconfirmed"]);
  });

  it("honours the dates-pending-official tag, case- and space-insensitively", () => {
    expect(evaluateOutreachReasons(healthy({ tags: [" Dates-Pending-Official "] }), NOW)).toContain(
      "dates_pending_official_tag"
    );
  });

  it("flags an event that started while still SCHEDULED", () => {
    const r = evaluateOutreachReasons(
      healthy({ startDate: new Date("2026-08-01T12:00:00Z"), lifecycleStatus: "SCHEDULED" }),
      NOW
    );
    expect(r).toContain("started_but_never_updated");
  });

  it("does NOT flag a past event whose lifecycle actually moved", () => {
    // OCCURRED/CANCELLED means something was watching. Asking the organizer
    // about a fair we know has happened is the ask that makes people stop
    // replying.
    const r = evaluateOutreachReasons(
      healthy({ startDate: new Date("2026-08-01T12:00:00Z"), lifecycleStatus: "OCCURRED" }),
      NOW
    );
    expect(r).not.toContain("started_but_never_updated");
  });

  it("flags missing hours", () => {
    expect(evaluateOutreachReasons(healthy({ eventDayCount: 0 }), NOW)).toContain("missing_hours");
  });

  it("asks about vendor applications ONLY where vendors are accepted", () => {
    // One reply is all we get; spending it asking a fair that takes no vendors
    // where to apply wastes it.
    expect(
      evaluateOutreachReasons(
        healthy({ commercialVendorsAllowed: true, vendorApplicationUrl: null }),
        NOW
      )
    ).toContain("missing_vendor_application");
    expect(
      evaluateOutreachReasons(
        healthy({ commercialVendorsAllowed: false, vendorApplicationUrl: null }),
        NOW
      )
    ).not.toContain("missing_vendor_application");
    expect(
      evaluateOutreachReasons(
        healthy({ commercialVendorsAllowed: true, vendorApplicationUrl: "https://x/apply" }),
        NOW
      )
    ).not.toContain("missing_vendor_application");
  });

  it("returns EVERY reason, not just the first", () => {
    // One email can ask for all of them. Two separate asks to the same
    // organizer is how a rail like this gets people to stop replying.
    const r = evaluateOutreachReasons(
      healthy({
        datesConfirmed: false,
        eventDayCount: 0,
        commercialVendorsAllowed: true,
        vendorApplicationUrl: null,
      }),
      NOW
    );
    expect(r).toEqual(["dates_unconfirmed", "missing_hours", "missing_vendor_application"]);
  });
});

describe("classifyContact", () => {
  it("recognises a real, reachable promoter", () => {
    expect(classifyContact({ promoterName: "Grange", promoterContactEmail: "a@b.c" })).toBe(
      "contactable"
    );
  });

  it("recognises the system placeholder as unreachable", () => {
    // The Dartmouth case: a promoter row exists, so a naive "has promoter"
    // check passes, and there is still nobody to write to.
    expect(
      classifyContact({
        promoterName: PLACEHOLDER_PROMOTER_NAME,
        promoterContactEmail: "hello@meetmeatthefair.com",
      })
    ).toBe("placeholder_promoter");
  });

  it("distinguishes a real promoter with no email from no promoter at all", () => {
    // They route to different fixes: enrich this promoter, versus attach one.
    expect(classifyContact({ promoterName: "Grange", promoterContactEmail: null })).toBe(
      "promoter_missing_email"
    );
    expect(classifyContact({ promoterName: null, promoterContactEmail: null })).toBe("no_promoter");
  });

  it("treats a whitespace-only email as missing", () => {
    expect(classifyContact({ promoterName: "Grange", promoterContactEmail: "   " })).toBe(
      "promoter_missing_email"
    );
  });
});

describe("buildOutreachQueueRow", () => {
  it("returns null when nothing needs asking", () => {
    expect(buildOutreachQueueRow("e1", healthy(), NOW)).toBeNull();
  });

  it("KEEPS an un-contactable event in the queue, marked blocked", () => {
    // Dropping it would hide the largest and most fixable segment and make the
    // queue read "few events need confirmation" when the truth is "we cannot
    // reach anyone about most of them".
    const row = buildOutreachQueueRow(
      "e1",
      healthy({ datesConfirmed: false, promoterName: PLACEHOLDER_PROMOTER_NAME }),
      NOW
    );
    expect(row).not.toBeNull();
    expect(row!.actionable).toBe(false);
    expect(row!.blockedOn).toBe("promoter_enrichment");
    expect(row!.reasons).toContain("dates_unconfirmed");
  });

  it("marks a contactable event actionable with no blocker", () => {
    const row = buildOutreachQueueRow("e1", healthy({ datesConfirmed: false }), NOW);
    expect(row!.actionable).toBe(true);
    expect(row!.blockedOn).toBeNull();
  });
});
