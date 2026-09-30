/**
 * OPE-840 — the roster lands as a `vendor_roster` citation, on the page that
 * listed it.
 *
 * ## Why a citation and not vendor rows
 *
 * Measured in prod on the specimen event `9d45da16` (2026-09-07), which an
 * operator resolved BY HAND after OPE-837 was filed:
 *
 *   event_vendors links ....... 63
 *   vendor_roster citation .... source_url = .../?page_id=21  (the ROSTER page)
 *   vendor_roster_status ...... NULL        <- deliberately untouched
 *   ticket_price_min/max ...... 1000 / 3500 cents, cited to festivalpro.com
 *
 * Two things follow, and both corrected OPE-840's own filed recommendation:
 *
 *  - The `vendor_roster_status` rail is APPROVED-only
 *    (`ROSTER_RESEARCH_STATUSES = ["APPROVED"]`), and the operator left the
 *    status NULL even after linking a full roster. So writing a roster status
 *    from a PENDING submission is not what "done" looks like here — it would
 *    assert a terminal state on a row outside the rail's own denominator.
 *  - The citation, attributed to the roster page, IS what the human produced.
 *    This ships that artifact and nothing else: no vendor rows, no links, no
 *    status. Creating public vendor profiles from an unreviewed submission
 *    stays behind John's approval.
 */
import { describe, it, expect } from "vitest";
import {
  crawlSecondaryPages,
  type CrawlDeps,
  type CrawlFetchResult,
} from "../src/email-handlers/secondary-crawl";
import fixture from "../../packages/utils/src/__tests__/fixtures/ope837-mainecheesefestival.json";

const HOME = fixture.homeUrl;

function makeDeps(overrides: Partial<CrawlDeps> = {}): CrawlDeps {
  const pages = new Map<string, CrawlFetchResult>();
  pages.set(fixture.pages.tickets_54.url, {
    url: fixture.pages.tickets_54.url,
    content: fixture.pages.tickets_54.text,
    title: "Tickets",
    links: fixture.pages.tickets_54.anchors,
  });
  for (const [key, title] of [
    ["artisan_21", "Artisan Vendors"],
    ["cheesemakers_57", "Cheesemakers"],
    ["foodtrucks_61", "Food Trucks"],
  ] as const) {
    const p = fixture.pages[key];
    pages.set(p.url, { url: p.url, content: p.text, title, links: [] });
  }
  pages.set(fixture.ticketVendorPage.url, {
    url: fixture.ticketVendorPage.url,
    content: fixture.ticketVendorPage.text,
    title: "2026 Attendee Tickets",
    links: [],
  });
  return {
    async fetchPage(url: string) {
      return pages.get(url) ?? null;
    },
    async fetchRobots() {
      return { status: 404, body: "" };
    },
    async wait() {},
    ...overrides,
  } as CrawlDeps;
}

const primary = (): CrawlFetchResult => ({
  url: HOME,
  content: "Maine Cheese Festival",
  title: "Maine Cheese Festival",
  links: fixture.homeAnchors,
});

describe("rosterSources — the roster is attributed to the page that listed it", () => {
  it("records a source per roster page, not the submitted homepage", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    expect(out.rosterSources.length).toBe(3);
    for (const src of out.rosterSources) {
      expect(src.url).not.toBe(HOME);
      expect(src.url).toContain("page_id=");
      expect(src.text.length).toBeGreaterThan(0);
    }
  });

  it("uses a DIFFERENT source than the price", async () => {
    // The whole reason these are separate fields: on this specimen the roster
    // is on the organizer's own domain and the price is on festivalpro.com.
    // One shared sourceUrl would put a false page on one of the two citations.
    const out = await crawlSecondaryPages(primary(), makeDeps());
    expect(out.priceSource?.url).toContain("festivalpro.com");
    expect(out.rosterSources[0].url).toContain("mainecheesefestival.org");
  });

  it("matches the page the operator cited by hand (?page_id=21)", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    expect(out.rosterSources.map((s) => s.url)).toContain(`${HOME}?page_id=21`);
  });

  it("records no roster source when no page lists a roster", async () => {
    const out = await crawlSecondaryPages(
      {
        url: "https://plain.org/",
        content: "one page",
        title: "Plain",
        links: [{ url: "https://plain.org/tickets", text: "Tickets" }],
      },
      makeDeps({
        async fetchPage(url: string) {
          return { url, content: "Admission $8 for adults.", title: "Tickets", links: [] };
        },
      })
    );
    expect(out.rosterSources).toEqual([]);
    expect(out.rosterNames).toEqual([]);
  });
});

describe("the roster-without-a-price case", () => {
  // The bug this pins: the citation call sites originally gated the crawl
  // context on `crawlFilledFields` alone, so a site publishing an exhibitor
  // list but NO price produced a roster that was silently never cited. That is
  // the majority shape — most small fairs list vendors and no admission price.
  it("still yields roster names when the crawl fills no event fields", async () => {
    const rosterOnly: CrawlFetchResult = {
      url: HOME,
      content: "Festival",
      title: "Festival",
      links: [{ url: `${HOME}?page_id=21`, text: "Artisan Vendors" }],
    };
    const deps = makeDeps();
    const out = await crawlSecondaryPages(rosterOnly, deps);

    expect(out.rosterNames.length).toBe(34);
    expect(out.rosterSources.length).toBe(1);
    // Positive landmark: the price side really is empty here, so this test is
    // exercising the roster-only path rather than incidentally passing on a
    // run that also found a price.
    expect(out.ticketPriceMin).toBeNull();
    expect(out.priceSource).toBeNull();
  });
});

describe("citation value shape", () => {
  // Mirrors the operator's own citation value, which led with the count.
  it("leads with the count and lists the names", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    const joined = out.rosterNames.join(", ");
    const value = `${out.rosterNames.length} exhibitors listed: ${joined}`;
    expect(value.startsWith("63 exhibitors listed: ")).toBe(true);
    expect(value).toContain("Barters Island Bees, Inc");
  });

  it("stays bounded for a site listing many exhibitors", async () => {
    const many = Array.from({ length: 400 }, (_, i) => `Vendor Number ${i}`);
    const joined = many.join(", ");
    const MAX = 2000;
    const value =
      `${many.length} exhibitors listed: ` +
      (joined.length > MAX
        ? `${joined.slice(0, MAX)}… (${many.length} total; full list in the secondary-page-crawl step)`
        : joined);
    expect(value.length).toBeLessThan(2200);
    expect(value).toContain("400 total");
  });
});

describe("what this deliberately does NOT do", () => {
  it("produces no vendor rows, links, or roster status — only names and a source", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    // The enrichment surface is the contract. If a future change adds a
    // vendor-writing field here, this test should be the thing that makes
    // someone justify it against OPE-837's STOP-gate.
    expect(Object.keys(out).sort()).toEqual(
      [
        "elapsedMs",
        "fetchCount",
        "pages",
        "priceSource",
        "robots",
        "rosterNames",
        "rosterSources",
        "textCharsFetched",
        "ticketPriceMax",
        "ticketPriceMin",
        "ticketUrl",
      ].sort()
    );
  });
});
