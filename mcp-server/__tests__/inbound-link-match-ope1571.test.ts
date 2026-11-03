/**
 * OPE-1571 — the inbound briefing matched a known event's link spelled a
 * different way (Cheddar Up) as "not ours", then text-matched a different fair.
 *
 * Fixtures are the prod rows read 2026-11-03: VCS Holiday Market 2026
 * (`b52c6acf`, Vassalboro) stores the subdomain form of its Cheddar Up link in
 * both source_url and application_url; Holiday Craft & Vendor Fair 2026
 * (`cc30d751`, Waterville) is the event the text match wrongly named. Inbound
 * `de188d66`'s body was the one link.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./setup-db.js";
import { linkKey, sameLink } from "../src/inbound/link-key.js";
import { buildVendorInquiryBriefing } from "../src/inbound/vendor-inquiry-briefing.js";
import {
  decideTextMatch,
  matchEventFromText,
  scoreCandidates,
  type TextMatchCandidateInput,
} from "../src/inbound/text-event-match.js";
import type { Db } from "../src/db.js";

const STORED = "https://holiday-market-vendor-registration-49978.cheddarup.com/";
const EMAILED = "https://my.cheddarup.com/c/holiday-market-vendor-registration-49978/items";
const T = (d: string) => Math.floor(new Date(d).getTime() / 1000);
const RECEIVED = new Date("2026-11-02T22:03:00Z");

describe("OPE-1571 — linkKey", () => {
  it("ACCEPTANCE: same-slug Cheddar Up links in either form match each other", () => {
    expect(sameLink(STORED, EMAILED)).toBe(true);
    expect(
      sameLink(STORED, "https://my.cheddarup.com/c/holiday-market-vendor-registration-49978")
    ).toBe(true);
    expect(linkKey(EMAILED)).toMatchObject({
      key: "cheddarup:holiday-market-vendor-registration-49978",
      rule: "cheddarup",
    });
  });

  it("ACCEPTANCE: different Cheddar Up slugs do not match", () => {
    expect(
      sameLink(STORED, "https://my.cheddarup.com/c/spring-market-vendor-registration-50001/items")
    ).toBe(false);
    expect(sameLink(STORED, "https://spring-market-12.cheddarup.com/")).toBe(false);
  });

  it("the platform's own hosts are never read as a collection slug", () => {
    expect(linkKey("https://my.cheddarup.com/")?.rule).toBe("url");
    expect(linkKey("https://www.cheddarup.com/pricing")?.rule).toBe("url");
  });

  it("Eventbrite: /e/<id> and /e/<name>-tickets-<id> are one page (the live 301), query ignored", () => {
    const long =
      "https://www.eventbrite.com/e/braintree-holiday-craft-and-vendor-fair-tickets-1983100424754";
    expect(sameLink(long, "https://www.eventbrite.com/e/1983100424754")).toBe(true);
    expect(sameLink(long, `${long}?aff=ebdssbdestsearch`)).toBe(true);
    expect(sameLink(long, "https://www.eventbrite.com/e/fall-fair-tickets-1998370390633")).toBe(
      false
    );
  });

  it("Facebook events: keyed on the numeric id — the tracking query and name segments drop out", () => {
    const stored = "https://www.facebook.com/events/27403863615936846/";
    expect(
      sameLink(
        stored,
        "https://www.facebook.com/events/27403863615936846/?acontext=%7B%7D&__tn__=H-R"
      )
    ).toBe(true);
    expect(
      sameLink(
        "https://www.facebook.com/events/willows-highlands-farm/willows-highlands-makers-market/1764444300869259/",
        "https://facebook.com/events/1764444300869259"
      )
    ).toBe(true);
    expect(sameLink(stored, "https://www.facebook.com/events/1104979745644589/")).toBe(false);
  });

  it("Google Forms: the long form collapses /viewform + ?usp=; a forms.gle short code stays its own key", () => {
    const id = "1FAIpQLSfl1rcLsiVSb09jX0VejH1vh2Ww76FTM9VjrzYU4VGHbJFsEg";
    expect(
      sameLink(
        `https://docs.google.com/forms/d/e/${id}/viewform?usp=header`,
        `https://docs.google.com/forms/d/e/${id}/viewform`
      )
    ).toBe(true);
    expect(
      sameLink(
        `https://docs.google.com/forms/d/e/${id}/viewform`,
        "https://forms.gle/JgTTZhNyFKn9Dx7j9"
      )
    ).toBe(false);
  });

  it("generic links: www, trailing slash and tracking params ignored; identifying params kept", () => {
    expect(
      sameLink("https://www.foo.org/fair/", "https://foo.org/fair?utm_source=x&fbclid=y")
    ).toBe(true);
    expect(sameLink("https://foo.org/e?id=1", "https://foo.org/e?id=2")).toBe(false);
    expect(linkKey("not a url at all")).toBeNull();
    expect(linkKey("mailto:a@b.org")).toBeNull();
  });
});

// ── Briefing integration ────────────────────────────────────────────────────
let db: Db;
let raw: { exec: (s: string) => unknown };

function venue(id: string, name: string, city: string) {
  raw.exec(
    `INSERT INTO venues (id, name, slug, city, state) VALUES ('${id}', '${name}', '${id}', '${city}', 'ME')`
  );
}
function event(
  id: string,
  name: string,
  start: string,
  venueId: string,
  extra: Record<string, string> = {}
) {
  const cols = [
    "id",
    "name",
    "slug",
    "promoter_id",
    "venue_id",
    "start_date",
    "end_date",
    "status",
    ...Object.keys(extra),
  ];
  const vals = [
    `'${id}'`,
    `'${name.replace(/'/g, "''")}'`,
    `'${id}'`,
    "'p1'",
    `'${venueId}'`,
    String(T(start)),
    String(T(start)),
    "'APPROVED'",
    ...Object.values(extra).map((v) => `'${v}'`),
  ];
  raw.exec(`INSERT INTO events (${cols.join(",")}) VALUES (${vals.join(",")})`);
}

beforeEach(() => {
  const t = createTestDb();
  db = t.db as unknown as Db;
  raw = t.raw as unknown as typeof raw;
  raw.exec(
    `INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'Some Promoter', 'some-promoter')`
  );
  venue("v-vass", "Vassalboro Community School", "Vassalboro");
  venue("v-wat", "Elks Lodge", "Waterville");
  event("b52c6acf", "VCS Holiday Market 2026", "2026-12-05T14:00:00Z", "v-vass", {
    source_url: STORED,
    application_url: STORED,
  });
  event("cc30d751", "Holiday Craft & Vendor Fair 2026", "2026-11-21T14:00:00Z", "v-wat");
});

const DE188D66 = {
  id: "de188d66",
  fromAddress: "carolyn@example.org",
  subject: null,
  parsedUrl: EMAILED,
  bodyText: EMAILED,
  receivedAt: RECEIVED,
};

describe("OPE-1571 — replay of inbound de188d66", () => {
  it("ACCEPTANCE: matches b52c6acf on a URL key, and does not name cc30d751", async () => {
    const b = await buildVendorInquiryBriefing(db, DE188D66);
    expect(b.matchedEvent?.id).toBe("b52c6acf");
    expect(b.matchedEvent?.matchedOn).toBe("source_url");
    expect(b.urlResolution.status).toBe("linked-event");
    expect(b.urlResolution.detail).toContain("cheddarup:holiday-market-vendor-registration-49978");
    expect(JSON.stringify(b)).not.toContain("cc30d751");
  });

  it("LANDMARK: the old exact-string comparison would have missed — the stored and emailed strings differ", () => {
    expect(STORED).not.toBe(EMAILED);
  });

  it("matches on application_url when only that field holds the page", async () => {
    raw.exec(
      `UPDATE events SET source_url = 'https://vassalboroschool.org/' WHERE id = 'b52c6acf'`
    );
    const b = await buildVendorInquiryBriefing(db, DE188D66);
    expect(b.matchedEvent).toMatchObject({ id: "b52c6acf", matchedOn: "application_url" });
  });

  it("a rejected or merged row holding the link never matches", async () => {
    raw.exec(`UPDATE events SET status = 'REJECTED' WHERE id = 'b52c6acf'`);
    const b = await buildVendorInquiryBriefing(db, DE188D66);
    expect(b.matchedEvent?.id).not.toBe("b52c6acf");
  });

  it("two editions storing the same link: the soonest not yet over wins, and the other is named", async () => {
    event("vcs-2025", "VCS Holiday Market 2025", "2025-12-06T14:00:00Z", "v-vass", {
      source_url: STORED,
    });
    event("vcs-2027", "VCS Holiday Market 2027", "2027-12-04T14:00:00Z", "v-vass", {
      source_url: STORED,
    });
    const b = await buildVendorInquiryBriefing(db, DE188D66);
    expect(b.matchedEvent?.id).toBe("b52c6acf");
    const w = b.warnings.join(" ");
    expect(w).toContain("VCS Holiday Market 2027");
    expect(w).toContain("VCS Holiday Market 2025");
  });

  it("a link match outranks a text match, and a disagreeing text match is recorded", async () => {
    const b = await buildVendorInquiryBriefing(db, {
      ...DE188D66,
      subject: "Holiday Craft & Vendor Fair in Waterville",
      bodyText: `${EMAILED}\nSee you at the Holiday Craft & Vendor Fair in Waterville on Nov 21!`,
    });
    expect(b.matchedEvent?.id).toBe("b52c6acf");
    expect(b.warnings.join(" ")).toMatch(
      /TEXT points at a different event, "Holiday Craft & Vendor Fair 2026"/
    );
  });

  it("without any stored link, the same email is NOT text-matched to the Waterville fair", async () => {
    raw.exec(`UPDATE events SET source_url = NULL, application_url = NULL WHERE id = 'b52c6acf'`);
    const b = await buildVendorInquiryBriefing(db, DE188D66);
    expect(b.matchedEvent).toBeNull();
    expect(b.urlResolution.status).toBe("not-ours");
  });
});

describe("OPE-1571 — a text match on common words alone names no event", () => {
  const cand = (id: string, name: string, city: string): TextMatchCandidateInput => ({
    id,
    slug: id,
    name,
    variants: [],
    startDate: T("2026-11-21T00:00:00Z"),
    endDate: null,
    city,
    promoterName: null,
  });

  it("ACCEPTANCE: 'holiday' + 'vendor' alone → candidates, not a match", async () => {
    const r = await matchEventFromText(db as never, {
      subject: null,
      bodyText: EMAILED,
      receivedAt: Math.floor(RECEIVED.getTime() / 1000),
    });
    expect(r.outcome).not.toBe("matched");
    const wat = r.candidates.find((c) => c.id === "cc30d751");
    expect(wat?.eligible).toBe(false);
    expect(wat?.reasons.join(" ")).toContain("only common words shared");
  });

  it("the same weak words DO match once the event's town is named", () => {
    const scored = scoreCandidates(
      {
        subject: "Holiday vendor fair",
        bodyText: "Looking for a holiday vendor spot in Waterville",
        receivedAt: T("2026-11-02T00:00:00Z"),
      },
      [cand("cc30d751", "Holiday Craft & Vendor Fair 2026", "Waterville")]
    );
    expect(decideTextMatch(scored, ["holiday"]).outcome).toBe("matched");
  });

  it("a distinctive word alongside the weak ones still matches without a town", () => {
    const scored = scoreCandidates(
      {
        subject: "Readfield Christmas Bazaar",
        bodyText: "",
        receivedAt: T("2026-11-02T00:00:00Z"),
      },
      [cand("rf", "Readfield Christmas Bazaar", "Readfield Depot")]
    );
    expect(scored[0].eligible).toBe(true);
  });
});
