/**
 * OPE-1636 part B — recurring feed discovery, on the real 0441 DDL with a fake
 * network (every URL the probe requests is recorded, so "only its own domain
 * list" and "a 403 stops" are asserted on the requests, not on the result).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  calendarLinksFromHtml,
  eventsPageFromHtml,
  googleEmbedToIcs,
  probeDomain,
} from "../src/feeds/discovery.js";
import {
  eligiblePromoterIds,
  listFeedDiscoveryRuns,
  loadDiscoveryFunnel,
  probePromoter,
  recordFeedDiscoveryFiling,
  runFeedDiscoverySlice,
} from "../src/feeds/discovery-run.js";
import { discoveryTicket, registerFeedDiscoveryTools } from "../src/tools/admin-feed-discovery.js";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const NOW = new Date("2026-11-26T21:00:00Z");
let db: TestDb;
let raw: Database.Database;
const run = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...p);

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:a1
DTSTART;VALUE=DATE:20261205
SUMMARY:Holiday Craft Fair
END:VEVENT
BEGIN:VEVENT
UID:a2
DTSTART;VALUE=DATE:20270110
SUMMARY:Winter Antiques Show
END:VEVENT
END:VCALENDAR`;
const TEC = JSON.stringify({
  events: [
    {
      id: 1,
      title: "Indoor Farmers&#8217; Market",
      start_date: "2026-12-06 09:00:00",
      end_date: "2026-12-06 12:00:00",
      url: "https://tec.example/event/1",
    },
    {
      id: 2,
      title: "Craft Fair",
      start_date: "2026-12-13 09:00:00",
      end_date: "2026-12-13 15:00:00",
      url: "https://tec.example/event/2",
    },
  ],
  total: 7,
});
const LD = `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Event",
  name: "Big Spring Expo",
  startDate: "2027-04-10T10:00:00-04:00",
  url: "https://ld.example/expo",
})}</script>`;

/** A fake web: path → [status, body]. Records every URL requested. */
function fakeWeb(pages: Record<string, [number, string]>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    const hit = pages[url];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit[1], { status: hit[0] });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

const WEB = {
  "https://tec.example/": [200, `<html><a href="/events/">Events</a></html>`],
  "https://tec.example/wp-json/tribe/events/v1/events?per_page=50": [200, TEC],
  "https://tec.example/events/?ical=1": [200, ICS],
  "https://tec.example/events/": [200, "<html>no ld here</html>"],
  "https://gcal.example/": [
    200,
    `<iframe src="https://calendar.google.com/calendar/embed?src=club%40gmail.com&amp;ctz=America%2FNew_York"></iframe>`,
  ],
  "https://calendar.google.com/calendar/ical/club%40gmail.com/public/basic.ics": [200, ICS],
  "https://ld.example/": [200, `<html>${LD}</html>`],
  "https://blocked.example/": [403, "Forbidden"],
  "https://plain.example/": [200, "<html>Squarespace site, no feed</html>"],
} as Record<string, [number, string]>;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  run("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')");
  run(
    `INSERT INTO promoters (id, company_name, slug, website) VALUES
      ('p-tec','TEC Fair','tec-fair','https://tec.example'),
      ('p-gcal','Gcal Club','gcal-club','https://gcal.example'),
      ('p-ld','LD Expo','ld-expo','https://ld.example'),
      ('p-block','Blocked Town','blocked-town','https://blocked.example'),
      ('p-plain','Plain Site','plain-site','https://plain.example'),
      ('p-nosite','No Site','no-site',NULL),
      ('p-fed','Already Fed','already-fed','https://fed.example')`
  );
  run(
    `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
     VALUES ('f-fed','p-fed','https://fed.example/wp-json/tribe/events/v1/events','tec_rest',1,1,1)`
  );
});

describe("page helpers (pure)", () => {
  it("turns a Google Calendar embed into its public iCal address", () => {
    expect(
      googleEmbedToIcs("https://calendar.google.com/calendar/embed?src=club%40gmail.com&ctz=X")
    ).toBe("https://calendar.google.com/calendar/ical/club%40gmail.com/public/basic.ics");
    expect(googleEmbedToIcs("https://example.com/embed?src=x")).toBeNull();
  });
  it("finds iCal links and embeds, normalising webcal and relative links", () => {
    const html = `<a href="webcal://x.example/cal.ics">sub</a><a href="/events/?ical=1">ics</a><a href="/about">no</a>`;
    expect(calendarLinksFromHtml(html, "https://x.example/").map((l) => l.url)).toEqual([
      "https://x.example/cal.ics",
      "https://x.example/events/?ical=1",
    ]);
  });
  it("finds the same-site events listing page, not an event detail page", () => {
    expect(
      eventsPageFromHtml(
        `<a href="/events/one-show">x</a><a href="https://www.x.example/events">E</a>`,
        "https://x.example/"
      )
    ).toBe("https://www.x.example/events");
  });
});

describe("probeDomain", () => {
  it("TEC REST + the plugin's iCal URL, with counts and sample titles", async () => {
    const w = fakeWeb(WEB);
    const r = await probeDomain("tec.example", { now: NOW, fetchImpl: w.fetchImpl });
    expect(r.outcome).toBe("found");
    expect(r.candidates.map((c) => [c.kind, c.found_via, c.item_count])).toEqual([
      ["tec_rest", "tec_rest_api", 7],
      ["ical", "tec_ical", 2],
    ]);
    expect(r.candidates[0].feed_url).toBe("https://tec.example/wp-json/tribe/events/v1/events");
    expect(r.candidates[0].sample_titles[0]).toMatch(/Indoor Farmers/);
  });
  it("a Google Calendar embed is a provider-hosted iCal candidate", async () => {
    const r = await probeDomain("gcal.example", { now: NOW, fetchImpl: fakeWeb(WEB).fetchImpl });
    expect(r.candidates).toMatchObject([
      { kind: "ical", found_via: "google_calendar_embed", item_count: 2, provider_hosted: true },
    ]);
  });
  it("JSON-LD on the home page", async () => {
    const r = await probeDomain("ld.example", { now: NOW, fetchImpl: fakeWeb(WEB).fetchImpl });
    expect(r.candidates).toMatchObject([
      {
        kind: "jsonld",
        found_via: "jsonld_home",
        item_count: 1,
        sample_titles: ["Big Spring Expo"],
      },
    ]);
  });
  it("a 403 stops the probe of that domain after ONE request", async () => {
    const w = fakeWeb(WEB);
    const r = await probeDomain("blocked.example", { now: NOW, fetchImpl: w.fetchImpl });
    expect(r.outcome).toBe("blocked");
    expect(w.requested).toEqual(["https://blocked.example/"]);
  });
  it("a site with no feed is 'none', and nothing it links is fetched off its host", async () => {
    const w = fakeWeb(WEB);
    expect((await probeDomain("plain.example", { now: NOW, fetchImpl: w.fetchImpl })).outcome).toBe(
      "none"
    );
    expect(w.requested.every((u) => u.startsWith("https://plain.example/"))).toBe(true);
  });
});

describe("the monthly run", () => {
  it("probes only the promoter's domain list, and a promoter with none is no_domain", async () => {
    run(`UPDATE promoters SET website = 'https://facebook.com/somefair' WHERE id = 'p-plain'`);
    const w = fakeWeb(WEB);
    const r = await probePromoter(db, "p-plain", { now: NOW, fetchImpl: w.fetchImpl });
    expect(r.outcome).toBe("no_domain");
    expect(w.requested).toEqual([]);
  });

  it("eligible = a website and no feed; never-probed first", async () => {
    const ids = await eligiblePromoterIds(db, "2026-11", 50);
    expect(ids.sort()).toEqual(["p-block", "p-gcal", "p-ld", "p-plain", "p-tec"]);
  });

  it("slices, completes, lists the new candidates with a ready ticket, and files once", async () => {
    const w = fakeWeb(WEB);
    const a = await runFeedDiscoverySlice(db, NOW, { batch: 3, fetchImpl: w.fetchImpl });
    expect(a).toMatchObject({ month: "2026-11", probed: 3, completed: false });
    const b = await runFeedDiscoverySlice(db, new Date(NOW.getTime() + 3_600_000), {
      batch: 3,
      fetchImpl: w.fetchImpl,
    });
    expect(b.probed).toBe(2);
    const c = await runFeedDiscoverySlice(db, new Date(NOW.getTime() + 7_200_000), {
      batch: 3,
      fetchImpl: w.fetchImpl,
    });
    expect(c).toMatchObject({ probed: 0, completed: true });

    const [r] = await listFeedDiscoveryRuns(db, { month: "2026-11" });
    expect(r).toMatchObject({ eligible: 5, probed: 5, found: 3, partial: false, ope_id: null });
    expect(r.new_candidates.map((p) => p.promoter_id).sort()).toEqual(["p-gcal", "p-ld", "p-tec"]);
    expect(r.blocked.map((p) => p.promoter_id)).toEqual(["p-block"]);
    const t = discoveryTicket(r);
    expect(t.title).toBe(
      "[agent instructions][analyst-claude-desktop][task] Feed discovery, month of November 2026: 3 promoters with a new feed candidate"
    );
    expect(t.body).toContain("https://tec.example/wp-json/tribe/events/v1/events");
    expect(t.body).toContain("Blocked Town");

    expect(await recordFeedDiscoveryFiling(db, "2026-11", "OPE-90010", NOW)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await recordFeedDiscoveryFiling(db, "2026-11", "OPE-90010", NOW)).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(await recordFeedDiscoveryFiling(db, "2026-11", "OPE-90011", NOW)).toMatchObject({
      ok: false,
    });
  });

  it("a month that ends first closes partial; next month probes the never-probed first and reports only NEW candidates", async () => {
    const w = fakeWeb(WEB);
    await runFeedDiscoverySlice(db, NOW, { batch: 2, fetchImpl: w.fetchImpl });
    const firstTwo = raw
      .prepare("SELECT promoter_id FROM feed_discovery_probes ORDER BY promoter_id")
      .all() as Array<{ promoter_id: string }>;
    const dec = new Date("2026-12-01T00:00:00Z");
    const d = await runFeedDiscoverySlice(db, dec, { batch: 3, fetchImpl: w.fetchImpl });
    expect(d.closed_previous).toEqual(["2026-11"]);
    const [nov] = await listFeedDiscoveryRuns(db, { month: "2026-11" });
    expect(nov).toMatchObject({ partial: true, probed: 2, eligible: 5 });
    const decProbed = (
      raw
        .prepare("SELECT promoter_id FROM feed_discovery_probes WHERE month = '2026-12'")
        .all() as Array<{ promoter_id: string }>
    ).map((x) => x.promoter_id);
    expect(decProbed.some((id) => firstTwo.some((f) => f.promoter_id === id))).toBe(false);
    // Finish December: the November finds re-appear in December but are not NEW.
    await runFeedDiscoverySlice(db, new Date(dec.getTime() + 3_600_000), {
      batch: 5,
      fetchImpl: w.fetchImpl,
    });
    await runFeedDiscoverySlice(db, new Date(dec.getTime() + 7_200_000), {
      batch: 5,
      fetchImpl: w.fetchImpl,
    });
    const [decRun] = await listFeedDiscoveryRuns(db, { month: "2026-12" });
    const novFound = new Set(nov.new_candidates.map((p) => p.promoter_id));
    expect(decRun.new_candidates.every((p) => !novFound.has(p.promoter_id))).toBe(true);
    expect(decRun.found).toBe(3);
  });

  it("the funnel: probed → found → registered → healthy → producing new to us", async () => {
    await runFeedDiscoverySlice(db, NOW, { batch: 10, fetchImpl: fakeWeb(WEB).fetchImpl });
    run(
      `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, last_ok_at, created_at, updated_at)
       VALUES ('f-tec','p-tec','https://tec.example/wp-json/tribe/events/v1/events','tec_rest',1,?,1,1),
              ('f-ld','p-ld','https://ld.example/','jsonld',1,NULL,1,1)`,
      Math.floor(NOW.getTime() / 1000) - 3600
    );
    run(
      `INSERT INTO promoter_feed_items (id, feed_id, external_id, review_state, first_seen_at, last_seen_at)
       VALUES ('i-new','f-tec','x','awaiting_review',1,1)`
    );
    expect(await loadDiscoveryFunnel(db, NOW)).toMatchObject({
      probed: 5,
      feed_found: 3,
      registered: 2,
      healthy: 1,
      producing_new_to_us: 1,
    });
  });
});

describe("tools", () => {
  it("probe_promoter_feeds is read-only and list_feed_discovery_runs offers the ticket", async () => {
    const w = fakeWeb(WEB);
    const ms = new CapturingMcpServer();
    registerFeedDiscoveryTools(ms as never, db, ADMIN as never, {
      now: () => NOW,
      fetchImpl: w.fetchImpl,
    });
    const out = JSON.parse(
      (
        (await ms.invoke("probe_promoter_feeds", { promoter_ids: ["p-tec", "p-block"] })) as {
          content: Array<{ text: string }>;
        }
      ).content[0].text
    );
    expect(out).toMatchObject({ probed: 2, found: 1 });
    expect(raw.prepare("SELECT COUNT(*) n FROM feed_discovery_probes").get()).toEqual({ n: 0 });

    await runFeedDiscoverySlice(db, NOW, { batch: 10, fetchImpl: w.fetchImpl });
    await runFeedDiscoverySlice(db, NOW, { batch: 10, fetchImpl: w.fetchImpl });
    const list = JSON.parse(
      ((await ms.invoke("list_feed_discovery_runs", {})) as { content: Array<{ text: string }> })
        .content[0].text
    );
    expect(list.to_file).toHaveLength(1);
    expect(list.to_file[0].ticket.title).toContain("Feed discovery, month of November 2026");
  });
});

describe("get_feed_lane_metrics carries the discovery funnel", () => {
  it("returns `discovery` from the shipped tool", async () => {
    await runFeedDiscoverySlice(db, NOW, { batch: 10, fetchImpl: fakeWeb(WEB).fetchImpl });
    const { registerOrganizerFeedTools } = await import("../src/tools/admin-organizer-feeds.js");
    const ms = new CapturingMcpServer();
    registerOrganizerFeedTools(ms as never, db, ADMIN as never, { now: () => NOW });
    const m = JSON.parse(
      ((await ms.invoke("get_feed_lane_metrics", {})) as { content: Array<{ text: string }> })
        .content[0].text
    ) as { discovery: { probed: number; feed_found: number } };
    expect(m.discovery).toMatchObject({ probed: 5, feed_found: 3 });
  });
});
