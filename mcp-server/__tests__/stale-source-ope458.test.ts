/**
 * OPE-458 scope 2 — a page frozen at 2024 is a fact about the SOURCE, not about
 * the events on it.
 *
 * Specimen: a bare URL to `vineyardartisans.com`, submitted 2026-08-17. Every
 * candidate the extractor produced was dated 2024. Three PENDING events were
 * created as if current, with no flag and no lifecycle transition.
 */
import { describe, expect, it } from "vitest";
import {
  classifySourceStaleness,
  sourceDomainOf,
  STALE_MARGIN_DAYS,
} from "../src/email-handlers/stale-source.js";

/** 2026-08-17, the day of the specimen submission. */
const NOW = Date.parse("2026-08-17T23:52:41Z");
const day = (n: number) => NOW + n * 24 * 60 * 60 * 1000;

describe("the Vineyard Artisans page", () => {
  const CANDIDATES = [
    { startDate: "2024-06-15" },
    { startDate: "2024-12-07" },
    { startDate: "2024-06-15" },
  ];

  it("is stale", () => {
    expect(classifySourceStaleness(CANDIDATES, NOW).stale).toBe(true);
  });

  it("reports the evidence, not just the verdict", () => {
    const v = classifySourceStaleness(CANDIDATES, NOW);
    expect(v.datedCount).toBe(3);
    // The NEWEST candidate is Dec 2024 — even the freshest thing on the page is
    // more than 20 months old.
    expect(v.newestAgeDays).toBeGreaterThan(600);
    expect(v.reason).toContain("newest");
  });
});

describe("what must NOT be called stale", () => {
  it("a page with one upcoming date, however much past content it also lists", () => {
    // Last year's edition still being listed is normal, not a defect. One
    // future date proves someone is maintaining the page.
    const v = classifySourceStaleness(
      [{ startDate: "2024-06-15" }, { startDate: "2025-06-15" }, { startDate: "2027-06-15" }],
      NOW
    );
    expect(v.stale).toBe(false);
    expect(v.reason).toContain("maintained");
  });

  it("a fair held last weekend", () => {
    // Post-event, not dead. These rows legitimately become OCCURRED through
    // OPE-201's existing rail; telling this organizer their page is out of date
    // would be both wrong and rude.
    const iso = new Date(day(-5)).toISOString().slice(0, 10);
    expect(classifySourceStaleness([{ startDate: iso }], NOW).stale).toBe(false);
  });

  it("a page whose newest event is just inside the margin", () => {
    const iso = new Date(day(-(STALE_MARGIN_DAYS - 1))).toISOString().slice(0, 10);
    expect(classifySourceStaleness([{ startDate: iso }], NOW).stale).toBe(false);
  });

  it("but is stale one day past the margin", () => {
    // Pins the boundary, so moving it later is a deliberate change.
    const iso = new Date(day(-(STALE_MARGIN_DAYS + 1))).toISOString().slice(0, 10);
    expect(classifySourceStaleness([{ startDate: iso }], NOW).stale).toBe(true);
  });

  it("a source with NO dated candidates — unknown is not stale", () => {
    // Absence of dates is a different failure (extraction, or a page that never
    // carried them). Reporting it as staleness sends the submitter off to fix a
    // page that may be perfectly current.
    const v = classifySourceStaleness([{ startDate: null }, {}], NOW);
    expect(v.stale).toBe(false);
    expect(v.datedCount).toBe(0);
    expect(v.newestAgeDays).toBeNull();
  });

  it("no candidates at all", () => {
    expect(classifySourceStaleness([], NOW).stale).toBe(false);
  });

  it("ignores an unparseable date rather than counting it as evidence", () => {
    const v = classifySourceStaleness(
      [{ startDate: "not-a-date" }, { startDate: "2024-06-15" }],
      NOW
    );
    expect(v.datedCount).toBe(1);
    expect(v.stale).toBe(true);
  });

  it("a page listing only far-future dates", () => {
    // The OPE-432 multi-edition shape (2026–2029). Nothing about it is stale.
    const v = classifySourceStaleness(
      [{ startDate: "2027-08-12" }, { startDate: "2028-08-10" }],
      NOW
    );
    expect(v.stale).toBe(false);
  });
});

describe("the DECISION is stable across workflow retries", () => {
  it("does not flip when a step re-runs later", () => {
    // This is what has to hold: a retried step must not reach a different
    // conclusion. The clock is injected rather than read inside, so a retry an
    // hour — or a day — later still judges the same page the same way.
    //
    // `newestAgeDays` is deliberately NOT pinned: it is a measurement, and it
    // genuinely ticks. Asserting it were frozen would be asserting something
    // false about a value whose whole job is to move.
    const c = [{ startDate: "2024-06-15" }];
    for (const skew of [60 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000]) {
      expect(classifySourceStaleness(c, NOW + skew).stale).toBe(true);
    }
  });
});

describe("sourceDomainOf", () => {
  it("matches the key source_reliability already uses", () => {
    // Its one live row is keyed `visitrhodeisland.com` — bare host, no scheme.
    expect(sourceDomainOf("https://www.VisitRhodeIsland.com/events?x=1")).toBe(
      "visitrhodeisland.com"
    );
  });

  it("keeps a subdomain that is not www", () => {
    expect(sourceDomainOf("https://events.example.org/a")).toBe("events.example.org");
  });

  it("returns null rather than a junk key", () => {
    expect(sourceDomainOf("not a url")).toBeNull();
    expect(sourceDomainOf("")).toBeNull();
    expect(sourceDomainOf(null)).toBeNull();
    expect(sourceDomainOf(undefined)).toBeNull();
  });
});

/**
 * The rule above is worth nothing if the reply never says it. A check that
 * exists but never runs is the recurring defect class in this repo.
 */
describe("the note reaches the submitter", () => {
  it("appends a stale-source note when the workflow flags one", async () => {
    const { buildReply } = await import("../src/email-reply-builder.js");
    const msg = buildReply("ok", "someone@example.com", {
      subject: "Our fair",
      eventName: "Vineyard Artisans Summer Festival",
      staleSourceDomains: ["vineyardartisans.com"],
    });
    expect(msg.text).toContain("vineyardartisans.com");
    expect(msg.text).toContain("has already");
  });

  it("never proposes a corrected year", async () => {
    // The ticket is explicit and OPE-433 sets the same rule: if the page does
    // not say 2026, saying 2026 is a fabrication. The copy asks; it does not
    // guess.
    const { buildReply } = await import("../src/email-reply-builder.js");
    const msg = buildReply("ok", "someone@example.com", {
      subject: "Our fair",
      staleSourceDomains: ["vineyardartisans.com"],
    });
    expect(msg.text).not.toMatch(/we've? (updated|corrected|changed) .*dates/i);
    expect(msg.text).toContain("haven't guessed");
  });

  it("says nothing at all when no source was stale", async () => {
    const { buildReply } = await import("../src/email-reply-builder.js");
    const msg = buildReply("ok", "someone@example.com", { subject: "Our fair" });
    expect(msg.text).not.toContain("has already");
  });

  it("keeps the sign-off last", async () => {
    // The note splices ABOVE the sign-off, like the receipt widget, or the
    // reply ends mid-paragraph after the signature.
    const { buildReply } = await import("../src/email-reply-builder.js");
    const msg = buildReply("ok", "someone@example.com", {
      subject: "Our fair",
      staleSourceDomains: ["vineyardartisans.com"],
    });
    const noteAt = msg.text.indexOf("has already");
    const signOffAt = msg.text.lastIndexOf("\n— ");
    expect(noteAt).toBeGreaterThan(-1);
    expect(signOffAt).toBeGreaterThan(noteAt);
  });

  it("lists several domains readably", async () => {
    const { buildReply } = await import("../src/email-reply-builder.js");
    const msg = buildReply("ok-multi", "someone@example.com", {
      subject: "Our fairs",
      eventCount: 2,
      resultsText: "…",
      staleSourceDomains: ["a.example", "b.example"],
    });
    expect(msg.text).toContain("a.example and b.example");
  });

  it("ignores a malformed value rather than emitting a broken sentence", async () => {
    const { buildReply } = await import("../src/email-reply-builder.js");
    const msg = buildReply("ok", "someone@example.com", {
      subject: "Our fair",
      staleSourceDomains: [""],
    });
    expect(msg.text).not.toContain("has already");
  });
});
