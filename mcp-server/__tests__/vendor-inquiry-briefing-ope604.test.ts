/**
 * OPE-604 — assemble a vendor_inquiry answer's inputs; assert nothing is invented.
 *
 * The specimen: inbound `310394ed`, TIMEPROOFUSA re: Winterfair Hartford 2026,
 * 2026-08-27. Six lookups, three of them surfacing facts the operator could not
 * have known from /admin — the worst being an event whose seven dates were a
 * PROJECTION off the 2025 pattern while `dates_confirmed = true` with ZERO
 * citations. A reply written from the admin row would have quoted a stranger
 * dates we invented.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  buildVendorInquiryBriefing,
  brandKey,
  senderNameVariants,
  subjectToEventQuery,
  matchVendorByVariants,
  readEventConfidence,
  distinctiveToken,
} from "../src/inbound/vendor-inquiry-briefing.js";

let db: TestDb;
let raw: { exec: (s: string) => unknown };
const NOW = Math.floor(new Date("2026-08-27T12:00:00Z").getTime() / 1000);

function seedPromoter(id = "p1", website: string | null = "https://promoter.example") {
  raw.exec(
    `INSERT INTO promoters (id, company_name, slug, website)
     VALUES ('${id}', 'Test Promoter', '${id}-slug', ${website ? `'${website}'` : "NULL"})`
  );
}

function seedEvent(o: {
  id: string;
  name: string;
  slug: string;
  endDate?: string;
  datesConfirmed?: number;
  sourceUrl?: string | null;
  applicationUrl?: string | null;
}) {
  const end = Math.floor(new Date(`${o.endDate ?? "2026-12-05"}T12:00:00Z`).getTime() / 1000);
  raw.exec(`
    INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, dates_confirmed,
                        status, lifecycle_status, source_url, application_url)
    VALUES ('${o.id}', '${o.name.replace(/'/g, "''")}', '${o.slug}', 'p1',
            ${end - 86400 * 6}, ${end}, ${o.datesConfirmed ?? 1},
            'APPROVED', 'SCHEDULED',
            ${o.sourceUrl ? `'${o.sourceUrl}'` : "NULL"},
            ${o.applicationUrl ? `'${o.applicationUrl}'` : "NULL"})
  `);
}

let vSeq = 0;
function seedVendor(businessName: string, website: string | null = null) {
  const id = `v${++vSeq}`;
  raw.exec(`
    INSERT INTO vendors (id, user_id, business_name, slug, website)
    VALUES ('${id}', 'u${vSeq}', '${businessName.replace(/'/g, "''")}', 'slug-${vSeq}',
            ${website ? `'${website}'` : "NULL"})
  `);
  return id;
}

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw as unknown as { exec: (s: string) => unknown };
  vSeq = 0;
  seedPromoter();
});

describe("brandKey — normalised on BOTH sides", () => {
  it("bridges the spaced and unspaced forms of the same brand", () => {
    // The live row is `TIMEPROOFUSA`, unspaced, created two months BEFORE the
    // inquiry — the opposite of the ticket's description. So the failure is
    // reading "Time Proof USA" off a signature and searching THAT: a substring
    // match cannot bridge inserted spaces in either direction.
    expect(brandKey("Time Proof USA")).toBe("timeproofusa");
    expect(brandKey("TIMEPROOFUSA")).toBe("timeproofusa");
    expect(brandKey("Time-Proof, U.S.A.")).toBe("timeproofusa");
  });
});

describe("senderNameVariants", () => {
  it("derives the brand from the email DOMAIN — the one stable identifier", () => {
    // A signature block can be restyled between messages; the sending domain
    // cannot.
    expect(senderNameVariants("events@timeproofusa.com")).toContain("timeproofusa");
  });

  it("ignores the mail-host label", () => {
    expect(senderNameVariants("x@mail.acmefairs.com")).toContain("acmefairs");
  });
});

describe("vendor matching", () => {
  it("finds an unspaced row from the SPACED name — the live failure", async () => {
    seedVendor("TIMEPROOFUSA", "https://www.timeproofusa.com/");
    const { match } = await matchVendorByVariants(db, ["Time Proof USA"]);
    expect(match).not.toBeNull();
    expect(match!.businessName).toBe("TIMEPROOFUSA");
    expect(match!.matchedVariant).toBe("brand-key");
  });

  it("reports WHICH variant matched, so the operator can judge it", async () => {
    seedVendor("Acme Fair Supplies");
    const { match } = await matchVendorByVariants(db, ["Acme Fair Supplies"]);
    expect(match!.matchedVariant).toBe("exact");
  });

  it("refuses to guess from a short fragment", async () => {
    // A 3-char fragment matches half a 6,566-row directory. A false "already a
    // vendor" is worse in a reply than an honest "not found".
    seedVendor("Northeastern Artisan Collective");
    const { match } = await matchVendorByVariants(db, ["nor"]);
    expect(match).toBeNull();
  });

  it("excludes soft-deleted rows — a tombstone's slug 301s away", async () => {
    const id = seedVendor("Ghost Vendor Co");
    raw.exec(`UPDATE vendors SET deleted_at = ${NOW} WHERE id = '${id}'`);
    const { match } = await matchVendorByVariants(db, ["Ghost Vendor Co"]);
    expect(match).toBeNull();
  });

  it("records every variant it tried, even when nothing matched", async () => {
    const { match, variantsTried } = await matchVendorByVariants(db, ["nobody-here-at-all"]);
    expect(match).toBeNull();
    expect(variantsTried).toContain("nobody-here-at-all");
  });
});

describe("event confidence — the standing trap", () => {
  it("WARNS on dates_confirmed=true with zero citations", async () => {
    seedEvent({ id: "e1", name: "Winterfair Hartford 2026", slug: "winterfair-hartford-2026" });
    const c = await readEventConfidence(db, "e1");
    expect(c.datesConfirmed).toBe(true);
    expect(c.activeCitations).toBe(0);
    // A zero must READ as a warning. Left as an empty field it looks like
    // "not checked", which is exactly the confusion that lets an unverified
    // date reach a stranger.
    expect(c.warning).toContain("0 active citations");
  });

  it("counts only ACTIVE citations — a superseded one supports nothing today", async () => {
    seedEvent({ id: "e1", name: "Winterfair Hartford 2026", slug: "w-2026" });
    raw.exec(`
      INSERT INTO event_data_citations (id, event_id, field_name, value, source_url, source_type, state, created_at, updated_at)
      VALUES ('c1','e1','start_date','x','https://o.example','official_website','superseded',${NOW},${NOW})
    `);
    const c = await readEventConfidence(db, "e1");
    expect(c.activeCitations).toBe(0);
    expect(c.warning).toContain("0 active citations");
  });

  it("stays quiet when the dates are actually supported", async () => {
    seedEvent({ id: "e1", name: "Real Fair", slug: "real-fair" });
    raw.exec(`
      INSERT INTO event_data_citations (id, event_id, field_name, value, source_url, source_type, state, created_at, updated_at)
      VALUES ('c1','e1','start_date','x','https://o.example','official_website','active',${NOW},${NOW})
    `);
    const c = await readEventConfidence(db, "e1");
    expect(c.activeCitations).toBe(1);
    expect(c.warning).toBeNull();
  });

  it("flags end_date disagreeing with the last event_days row", async () => {
    // The specimen's `end_date` still carried 2025's final day.
    seedEvent({ id: "e1", name: "Carryover Fair", slug: "carryover", endDate: "2026-12-05" });
    raw.exec(`INSERT INTO event_days (id, event_id, date) VALUES ('d1','e1','2026-12-07')`);
    const c = await readEventConfidence(db, "e1");
    expect(c.endDateMatchesLastDay).toBe(false);
    expect(c.warning).toContain("end_date disagrees");
  });

  it("reports null — not false — when there are no day rows to compare", async () => {
    seedEvent({ id: "e1", name: "No Days", slug: "no-days" });
    const c = await readEventConfidence(db, "e1");
    // `false` would assert a disagreement we never checked.
    expect(c.endDateMatchesLastDay).toBeNull();
  });
});

describe("subjectToEventQuery", () => {
  it("strips the inquiry boilerplate to leave the event name", () => {
    expect(subjectToEventQuery("Winterfair Hartford 2026 - Vendor Inquiry")).toBe(
      "Winterfair Hartford 2026"
    );
    expect(subjectToEventQuery("Re: Washington County Fair Inquiry")).toBe(
      "Washington County Fair"
    );
  });
});

describe("the assembled briefing", () => {
  it("matches on source_url in preference to the subject, and says so", async () => {
    seedEvent({
      id: "e1",
      name: "Winterfair Hartford 2026",
      slug: "winterfair-hartford-2026",
      sourceUrl: "https://organizer.example/winterfair",
    });
    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "events@timeproofusa.com",
      subject: "Winterfair Hartford 2026 - Vendor Inquiry",
      parsedUrl: "https://organizer.example/winterfair",
    });
    expect(b.matchedEvent?.matchedOn).toBe("source_url");
    // A URL is evidence; a subject-line name is an inference. Conflating them
    // is how the wrong event's dates reach a reply.
    expect(b.warnings.join(" ")).not.toContain("matched on SUBJECT TEXT");
  });

  it("warns when the event was matched on subject text alone", async () => {
    seedEvent({ id: "e1", name: "Winterfair Hartford 2026", slug: "winterfair-hartford-2026" });
    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "events@timeproofusa.com",
      subject: "Winterfair Hartford 2026 - Vendor Inquiry",
      parsedUrl: null,
    });
    expect(b.matchedEvent?.matchedOn).toBe("subject");
    expect(b.warnings.join(" ")).toContain("SUBJECT TEXT");
  });

  it("assembles the whole specimen and surfaces the date warning", async () => {
    seedEvent({ id: "e1", name: "Winterfair Hartford 2026", slug: "winterfair-hartford-2026" });
    seedVendor("TIMEPROOFUSA", "https://www.timeproofusa.com/");
    raw.exec(`
      INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, status, subject, inbound_email_id)
      VALUES ('m1', ${NOW}, 'events@timeproofusa.com', 'support-ack', 'sent', 'We got your note', 'i1')
    `);

    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "events@timeproofusa.com",
      subject: "Winterfair Hartford 2026 - Vendor Inquiry",
      parsedUrl: null,
    });

    expect(b.matchedEvent?.slug).toBe("winterfair-hartford-2026");
    expect(b.vendor?.businessName).toBe("TIMEPROOFUSA");
    expect(b.confidence?.activeCitations).toBe(0);
    expect(b.warnings.join(" ")).toContain("0 active citations");
    // "What we already sent them" — so a second touch does not contradict the ack.
    expect(b.priorSends).toHaveLength(1);
    expect(b.priorSends[0].subject).toBe("We got your note");
  });

  it("says so plainly when no event matched, rather than returning a blank", async () => {
    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "someone@example.com",
      subject: "Becoming a vendor",
      parsedUrl: null,
    });
    expect(b.matchedEvent).toBeNull();
    expect(b.warnings.join(" ")).toContain("No event matched");
  });

  it("warns that a missing application_url means NOT CAPTURED, not none", async () => {
    // OPE-526: application_url capture still is not landing on the scrape path,
    // so absence is not evidence the organizer has no application process.
    seedEvent({ id: "e1", name: "Some Fair", slug: "some-fair" });
    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "x@example.com",
      subject: "Some Fair",
      parsedUrl: null,
    });
    expect(b.warnings.join(" ")).toContain("hand off the organizer's own site");
  });

  it("generates NO prose — the briefing is data only", async () => {
    seedEvent({ id: "e1", name: "Some Fair", slug: "some-fair" });
    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "x@example.com",
      subject: "Some Fair",
      parsedUrl: null,
    });
    // The acceptance criterion is "no generated customer-facing prose ships
    // from this ticket". Pinned structurally: every field is an id, a URL, a
    // count, a flag, or an operator-facing warning.
    const keys = Object.keys(b);
    expect(keys).not.toContain("reply");
    expect(keys).not.toContain("draft");
    expect(keys).not.toContain("suggestedResponse");
  });
});

describe("distinctive-token fallback — the SoNo case", () => {
  it("resolves a subject that differs from the event name by ONE letter", async () => {
    // Live: subject "SoNo Art Festival" vs stored "SoNo Arts Festival 2026".
    // ART vs ARTS. Substring matching returns nothing, and the whole briefing
    // came back empty for a row whose event we hold — with citations and an
    // application URL ready to hand over.
    seedEvent({ id: "e1", name: "SoNo Arts Festival 2026", slug: "sono-arts-festival-2026" });
    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "carol.pace@davidlerner.com",
      subject: "SoNo Art Festival",
      parsedUrl: null,
    });
    expect(b.matchedEvent?.slug).toBe("sono-arts-festival-2026");
    expect(b.warnings.join(" ")).toContain("SINGLE TOKEN");
  });

  it("refuses to choose when the token is ambiguous", async () => {
    // Two events share the token, so it identifies nothing. Picking either
    // would put another fair's dates into a reply.
    seedEvent({ id: "e1", name: "Riverside Fair 2026", slug: "riverside-2026" });
    seedEvent({ id: "e2", name: "Riverside Fair 2027", slug: "riverside-2027" });
    const b = await buildVendorInquiryBriefing(db, {
      id: "i1",
      fromAddress: "x@example.com",
      subject: "Riverside Fair",
      parsedUrl: null,
    });
    expect(b.matchedEvent).toBeNull();
    expect(b.warnings.join(" ")).toContain("ambiguous");
  });

  it("never falls back on a GENERIC word", () => {
    // "Fair" alone would match hundreds of rows.
    expect(distinctiveToken("Fair")).toBeNull();
    expect(distinctiveToken("Craft Show")).toBeNull();
    expect(distinctiveToken("SoNo Art Festival")).toBe("sono");
  });
});
