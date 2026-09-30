/**
 * OPE-837 — the crawl orchestrator, and the ticket's acceptance replayed.
 *
 * The "replay" here drives the real orchestration (discovery → robots → cap →
 * classification → type-specific extraction → fill-empty-only) over the REAL
 * captured pages of the specimen site, with only the network injected. That is
 * the closest thing to `348593d0` that can run in CI, and it exercises every
 * decision the live path makes except the HTTP itself.
 */
import { describe, it, expect, vi } from "vitest";
import {
  crawlSecondaryPages,
  applyCrawlEnrichment,
  type CrawlDeps,
  type CrawlFetchResult,
} from "../src/email-handlers/secondary-crawl";
import fixture from "../../packages/utils/src/__tests__/fixtures/ope837-mainecheesefestival.json";

const HOME = fixture.homeUrl;

/** Build a fetcher over the captured pages; anything else 404s. */
function makeDeps(overrides: Partial<CrawlDeps> = {}): CrawlDeps & { fetched: string[] } {
  const fetched: string[] = [];
  const pages = new Map<string, CrawlFetchResult>();

  pages.set(HOME, {
    url: HOME,
    content: "Maine Cheese Festival",
    title: "Maine Cheese Festival",
    links: fixture.homeAnchors,
  });
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

  const deps: CrawlDeps & { fetched: string[] } = {
    fetched,
    async fetchPage(url: string) {
      fetched.push(url);
      return pages.get(url) ?? null;
    },
    async fetchRobots() {
      return { status: 404, body: "" };
    },
    async wait() {
      /* no sleeping in tests */
    },
    ...overrides,
  } as CrawlDeps & { fetched: string[] };
  return deps;
}

const primary = (): CrawlFetchResult => ({
  url: HOME,
  content: "Maine Cheese Festival September 13 2026 Manson Park",
  title: "Maine Cheese Festival",
  links: fixture.homeAnchors,
});

describe("OPE-837 acceptance — replay of the bare-URL submission", () => {
  it("discovers at least 3 of the 4 pages the ticket names", async () => {
    const deps = makeDeps();
    const out = await crawlSecondaryPages(primary(), deps);
    const hit = ["page_id=54", "page_id=21", "page_id=57", "page_id=61"].filter((id) =>
      out.pages.some((p) => p.url.includes(id))
    );
    expect(hit.length).toBeGreaterThanOrEqual(3);
    // Positive landmark: say how many candidates were on the table, so a
    // discovery step that silently stops matching cannot read as a pass.
    expect(fixture.homeAnchors.length).toBeGreaterThan(10);
    expect(hit.length).toBe(4);
  });

  it("carries a price range, from the off-site ticket vendor", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    expect(out.ticketPriceMin).toBe(10);
    expect(out.ticketPriceMax).toBe(35);
  });

  it("stores the festivalpro purchase URL, not the homepage", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    expect(out.ticketUrl).toContain("festivalpro.com");
    expect(out.ticketUrl).not.toBe(HOME);
  });

  it("collects >= 60 roster names", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    expect(out.rosterNames.length).toBeGreaterThanOrEqual(60);
    expect(out.rosterNames.length).toBe(63);
  });

  it("names every page fetched and its classification (scope 5)", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    for (const page of out.pages) {
      expect(page.url).toBeTruthy();
      expect(page.hintClass).toBeTruthy();
      expect(["ok", "no-fields", "fetch-failed", "robots-disallowed"]).toContain(page.outcome);
    }
    const vendorPages = out.pages.filter((p) => p.finalClass === "vendors");
    expect(vendorPages.length).toBe(3);
    expect(vendorPages.every((p) => p.rosterCount > 0)).toBe(true);
    // A page that produced nothing is still recorded — "did the crawl run"
    // must be answerable, so silence and success cannot look the same.
    expect(out.pages.length).toBeGreaterThan(vendorPages.length);
  });

  it("reports crawl cost", async () => {
    const out = await crawlSecondaryPages(primary(), makeDeps());
    expect(out.fetchCount).toBeGreaterThan(0);
    expect(out.textCharsFetched).toBeGreaterThan(0);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("bounds — this is a nav follower, not a spider", () => {
  it("performs ZERO fetches for a site whose nav carries no event fields", async () => {
    // `fetchRobots` is spied rather than asserted through `out.robots`: a
    // missing robots.txt and a never-requested one both report "none", so the
    // return value CANNOT distinguish "we skipped the crawl entirely" from
    // "we crawled and the robots fetch 404'd". Mutation-tested — deleting the
    // early return left this test green until the spy was added.
    const fetchRobots = vi.fn(async () => ({ status: 404, body: "" }));
    const deps = makeDeps({ fetchRobots });
    const plain: CrawlFetchResult = {
      url: "https://plain.org/",
      content: "A one page site",
      title: "Plain",
      links: [
        { url: "https://plain.org/about", text: "About" },
        { url: "https://plain.org/contact", text: "Contact" },
      ],
    };
    const out = await crawlSecondaryPages(plain, deps);
    expect(deps.fetched).toEqual([]);
    expect(out.fetchCount).toBe(0);
    expect(out.pages).toEqual([]);
    expect(out.robots).toBe("none");
    // The load-bearing assertion: no network at all, not even robots.txt.
    expect(fetchRobots).not.toHaveBeenCalled();
  });

  it("spends the off-site ticket hop AT MOST once, across several ticket pages", async () => {
    // The specimen has exactly one ticket page, so it cannot distinguish a
    // once-only hop from an unguarded one. This site has two, each linking a
    // different vendor — the only shape where the guard is observable.
    const fetchedOffSite: string[] = [];
    const twoTicketPages: CrawlFetchResult = {
      url: "https://two.org/",
      content: "Festival",
      title: "Festival",
      links: [
        { url: "https://two.org/tickets", text: "Tickets" },
        { url: "https://two.org/admission", text: "Admission" },
      ],
    };
    const pages: Record<string, CrawlFetchResult> = {
      "https://two.org/tickets": {
        url: "https://two.org/tickets",
        content: "Tickets",
        title: "Tickets",
        links: [{ url: "https://www.eventbrite.com/e/123", text: "Buy" }],
      },
      "https://two.org/admission": {
        url: "https://two.org/admission",
        content: "Admission",
        title: "Admission",
        links: [{ url: "https://dice.fm/event/456", text: "Buy" }],
      },
    };
    const deps: CrawlDeps = {
      async fetchPage(url: string) {
        if (!url.includes("two.org")) fetchedOffSite.push(url);
        return pages[url] ?? { url, content: "Buy tickets", title: "Buy", links: [] };
      },
      async fetchRobots() {
        return { status: 404, body: "" };
      },
      async wait() {},
    };
    await crawlSecondaryPages(twoTicketPages, deps);
    expect(fetchedOffSite).toHaveLength(1);
  });

  it("never leaves the site except for the single ticket-vendor hop", async () => {
    const deps = makeDeps();
    await crawlSecondaryPages(primary(), deps);
    const offSite = deps.fetched.filter((u) => !u.includes("mainecheesefestival.org"));
    expect(offSite).toHaveLength(1);
    expect(offSite[0]).toContain("festivalpro.com");
  });

  it("honours the cap", async () => {
    const deps = makeDeps();
    const out = await crawlSecondaryPages(primary(), deps, { cap: 2 });
    // 2 same-site targets, plus at most the one ticket hop.
    expect(out.pages.filter((p) => !p.offSiteTicketHop).length).toBeLessThanOrEqual(2);
  });

  it("does not re-fetch a page the email already caused us to fetch", async () => {
    const deps = makeDeps();
    await crawlSecondaryPages(primary(), deps, {
      alreadyFetched: [fixture.pages.artisan_21.url],
    });
    expect(deps.fetched).not.toContain(fixture.pages.artisan_21.url);
  });

  it("waits between requests", async () => {
    const wait = vi.fn(async () => {});
    const deps = makeDeps({ wait });
    await crawlSecondaryPages(primary(), deps);
    expect(wait).toHaveBeenCalled();
  });
});

describe("robots.txt", () => {
  it("skips a disallowed page and records why", async () => {
    const deps = makeDeps({
      async fetchRobots() {
        return { status: 200, body: "User-agent: *\nDisallow: /\n" };
      },
    });
    const out = await crawlSecondaryPages(primary(), deps);
    expect(deps.fetched).toEqual([]);
    expect(out.pages.every((p) => p.outcome === "robots-disallowed")).toBe(true);
    expect(out.rosterNames).toEqual([]);
  });

  it("stops on a 5xx robots.txt (RFC 9309 assume-disallow)", async () => {
    const deps = makeDeps({
      async fetchRobots() {
        return { status: 503, body: "" };
      },
    });
    const out = await crawlSecondaryPages(primary(), deps);
    expect(deps.fetched).toEqual([]);
    expect(out.robots).toBe("unavailable-stop");
  });

  it("crawls normally when robots.txt is missing (404)", async () => {
    const deps = makeDeps();
    const out = await crawlSecondaryPages(primary(), deps);
    expect(deps.fetched.length).toBeGreaterThan(0);
    expect(out.rosterNames.length).toBe(63);
  });

  it("blocks only the disallowed subtree", async () => {
    const deps = makeDeps({
      async fetchRobots() {
        // The specimen's pages are all "/" with a query, so target the query.
        return { status: 200, body: "User-agent: *\nDisallow: /?page_id=21\n" };
      },
    });
    const out = await crawlSecondaryPages(primary(), deps);
    const artisan = out.pages.find((p) => p.url.includes("page_id=21"));
    expect(artisan?.outcome).toBe("robots-disallowed");
    // Others still crawled.
    expect(out.rosterNames.length).toBeGreaterThan(20);
  });
});

describe("resilience — enrichment must never cost the primary event", () => {
  it("survives every secondary fetch failing", async () => {
    const deps = makeDeps({
      async fetchPage() {
        return null;
      },
    });
    const out = await crawlSecondaryPages(primary(), deps);
    expect(out.pages.every((p) => p.outcome === "fetch-failed")).toBe(true);
    expect(out.ticketPriceMin).toBeNull();
    expect(out.rosterNames).toEqual([]);
  });

  it("survives a fetcher that throws", async () => {
    const deps = makeDeps({
      async fetchPage() {
        throw new Error("boom");
      },
    });
    const out = await crawlSecondaryPages(primary(), deps);
    expect(out.pages.length).toBeGreaterThan(0);
  });

  it("does nothing when the primary page carried no links", async () => {
    const deps = makeDeps();
    const out = await crawlSecondaryPages({ ...primary(), links: [] }, deps);
    expect(deps.fetched).toEqual([]);
    expect(out.pages).toEqual([]);
  });
});

describe("applyCrawlEnrichment — fill-empty-only", () => {
  const enrichment = {
    ticketUrl: "https://vendor.com/buy",
    ticketPriceMin: 10,
    ticketPriceMax: 35,
  };

  it("fills fields the primary page left empty", () => {
    const ev = { ticketUrl: null, ticketPriceMin: null, ticketPriceMax: null };
    const filled = applyCrawlEnrichment(ev, enrichment, HOME);
    expect(ev.ticketPriceMin).toBe(10);
    expect(ev.ticketPriceMax).toBe(35);
    expect(filled).toContain("ticketPriceMin");
  });

  it("NEVER overwrites what the primary page established", () => {
    const ev = { ticketUrl: "https://organizer.org/tickets", ticketPriceMin: 5, ticketPriceMax: 9 };
    const filled = applyCrawlEnrichment(ev, enrichment, HOME);
    expect(ev.ticketPriceMin).toBe(5);
    expect(ev.ticketPriceMax).toBe(9);
    expect(ev.ticketUrl).toBe("https://organizer.org/tickets");
    expect(filled).toEqual([]);
  });

  it("replaces a ticketUrl that is merely the site homepage", () => {
    // The specimen's stored ticket_url was the homepage — a fallback, not a
    // ticket URL. This is the one documented exception to fill-empty-only.
    const ev = { ticketUrl: HOME, ticketPriceMin: null, ticketPriceMax: null };
    const filled = applyCrawlEnrichment(ev, enrichment, HOME);
    expect(ev.ticketUrl).toBe("https://vendor.com/buy");
    expect(filled).toContain("ticketUrl");
  });

  it("does not treat a DIFFERENT site's root as a fallback to replace", () => {
    const ev = {
      ticketUrl: "https://someone-else.org/",
      ticketPriceMin: null,
      ticketPriceMax: null,
    };
    applyCrawlEnrichment(ev, enrichment, HOME);
    expect(ev.ticketUrl).toBe("https://someone-else.org/");
  });

  it("is a no-op when the crawl found nothing", () => {
    const ev = { ticketUrl: null, ticketPriceMin: null, ticketPriceMax: null };
    const filled = applyCrawlEnrichment(ev, {
      ticketUrl: null,
      ticketPriceMin: null,
      ticketPriceMax: null,
    });
    expect(filled).toEqual([]);
    expect(ev.ticketUrl).toBeNull();
  });
});
