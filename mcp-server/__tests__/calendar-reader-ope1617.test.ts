/**
 * OPE-1617 — universal calendar reader: iCal (incl. Google / Outlook shapes),
 * schema.org Event JSON-LD, ownership proof, cancellation + drop signals,
 * conditional GET, backoff and the scheduler gate.
 *
 * The OHTM fixture is OHTM's own feed as served on 2026-11-10
 * (`https://owlshead.org/?ical=1&eventDisplay=list`), read once to build this
 * test. Nothing here touches the network: every fetch is a fake, and the test
 * asserts nothing reached email_send_ledger. Pipeline tests run on the real
 * 0406 + 0409 DDL (loaded from the migration files by setup-db).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";
import {
  expandRrule,
  parseIcsFeed,
  parseLocation,
  parseRrule,
  resolveTzid,
  unfoldLines,
} from "../src/feeds/ical.js";
import { eventsFromHtml, readJsonLdSource } from "../src/feeds/jsonld.js";
import { isCalendarProviderUrl } from "../src/feeds/ownership.js";
import { nextReadDelayMs } from "../src/feeds/fetch-feed.js";
import { pollDueFeeds } from "../src/feeds/schedule.js";

const OHTM_ICS = readFileSync(join(__dirname, "fixtures/ohtm-ical-2026-11-10.ics"), "utf8");
const W = { windowStart: "2026-01-01", windowEnd: "2027-12-31" };

const cal = (body: string, head = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${head}${body}END:VCALENDAR\r\n`;
const vevent = (lines: string[]) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;

// ------------------------------------------------------------------ parser

describe("OHTM's real iCal feed (2026-11-10)", () => {
  const r = parseIcsFeed(OHTM_ICS, { windowStart: "2026-11-10", windowEnd: "2027-12-31" });

  it("reads every VEVENT, in Eastern wall time as written", () => {
    // positive landmark: the fixture has 20 VEVENTs and none is skipped
    expect(r.events).toHaveLength(20);
    expect(r.skipped).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(r.calendarName).toBe("Owls Head Transportation Museum");
    const first = r.events[0];
    expect(first.title).toBe("Junior Inventors - 3D Shapes");
    // DTSTART;TZID=America/New_York:20261112T163000 → 16:30 local, NOT shifted by an offset.
    expect(first.startDate).toBe("2026-11-12");
    expect(first.startTime).toBe("16:30");
    expect(first.endTime).toBe("18:30");
    expect(first.timezone).toBe("America/New_York");
    expect(first.externalId).toBe("10001073-1794501000-1794508200@owlshead.org");
    expect(first.url).toBe("https://owlshead.org/event/junior-inventors-3d-shapes/");
    expect(r.events.every((e) => e.timezone === "America/New_York")).toBe(true);
  });

  it("maps TEC's LOCATION, ORGANIZER and ATTACH shapes", () => {
    const first = r.events[0];
    expect(first.venue).toEqual({
      name: "Science & Industry Center at the Owls Head Transportation Museum",
      address: "117 Museum St.",
      city: "Owls Head",
      state: "ME",
      zip: "04854",
    });
    expect(first.organizerEmails).toEqual(["education@ohtm.org"]);
    expect(r.events.some((e) => e.imageUrl?.startsWith("https://owlshead.org/wp-content/"))).toBe(
      true
    );
    // escaped commas and \n come back as text
    expect(first.description).toContain("3D pens, building geometric structures");
    expect(first.description).not.toContain("\\,");
  });
});

describe("iCal time handling", () => {
  it("converts Google's UTC times to the calendar's zone across DST", () => {
    const r = parseIcsFeed(
      cal(
        vevent([
          "UID:g1@google.com",
          "SUMMARY:Summer Fair",
          "DTSTART:20260704T140000Z",
          "DTEND:20260704T210000Z",
        ]) +
          vevent([
            "UID:g2@google.com",
            "SUMMARY:Holiday Fair",
            "DTSTART:20261205T150000Z",
            "DTEND:20261205T200000Z",
          ]),
        "X-WR-TIMEZONE:America/New_York\r\n"
      ),
      W
    );
    const [summer, winter] = r.events;
    expect([summer.startTime, summer.endTime]).toEqual(["10:00", "17:00"]); // EDT, UTC-4
    expect([winter.startTime, winter.endTime]).toEqual(["10:00", "15:00"]); // EST, UTC-5
    expect(summer.timezone).toBe("America/New_York");
  });

  it("treats VALUE=DATE as all-day with an EXCLUSIVE DTEND", () => {
    const r = parseIcsFeed(
      cal(
        vevent([
          "UID:a1",
          "SUMMARY:One Day",
          "DTSTART;VALUE=DATE:20260815",
          "DTEND;VALUE=DATE:20260816",
        ]) +
          vevent([
            "UID:a2",
            "SUMMARY:Three Days",
            "DTSTART;VALUE=DATE:20260904",
            "DTEND;VALUE=DATE:20260907",
          ])
      ),
      W
    );
    expect(r.events[0]).toMatchObject({
      allDay: true,
      startDate: "2026-08-15",
      endDate: "2026-08-15",
      startTime: null,
    });
    expect(r.events[1]).toMatchObject({ startDate: "2026-09-04", endDate: "2026-09-06" });
  });

  it("maps Outlook's Windows zone names and keeps floating times local", () => {
    expect(resolveTzid("Eastern Standard Time")).toBe("America/New_York");
    expect(resolveTzid("/mozilla.org/20050126_1/America/New_York")).toBe("America/New_York");
    expect(resolveTzid("Not/AZone")).toBeNull();
    const r = parseIcsFeed(
      cal(
        vevent([
          "UID:o1",
          "SUMMARY:Outlook",
          'DTSTART;TZID="Eastern Standard Time":20260610T090000',
          "DURATION:PT3H",
        ]) + vevent(["UID:f1", "SUMMARY:Floating", "DTSTART:20260611T183000"])
      ),
      { ...W, defaultTz: "America/New_York" }
    );
    expect(r.events[0]).toMatchObject({
      startTime: "09:00",
      endTime: "12:00",
      timezone: "America/New_York",
    });
    expect(r.events[1]).toMatchObject({ startTime: "18:30", timezone: "America/New_York" });
  });

  it("unfolds continuation lines and unescapes TEXT", () => {
    expect(unfoldLines("SUMMARY:Big\r\n  Fair\r\nX:y")).toEqual(["SUMMARY:Big Fair", "X:y"]);
    const r = parseIcsFeed(
      cal(
        vevent([
          "UID:t1",
          "SUMMARY:Arts\\, Crafts \\; More",
          "DTSTART;VALUE=DATE:20260801",
          "DESCRIPTION:<p>Line one</p><p>Two</p>",
        ])
      ),
      W
    );
    expect(r.events[0].title).toBe("Arts, Crafts ; More");
    expect(r.events[0].description).toBe("Line one\nTwo");
  });
});

describe("iCal recurrence", () => {
  it("expands WEEKLY, drops EXDATE, and applies a cancelled RECURRENCE-ID to one date only", () => {
    const r = parseIcsFeed(
      cal(
        vevent([
          "UID:market@x",
          "SUMMARY:Farmers Market",
          "DTSTART;TZID=America/New_York:20260606T090000",
          "DTEND;TZID=America/New_York:20260606T130000",
          "RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=5",
          "EXDATE;TZID=America/New_York:20260613T090000",
        ]) +
          vevent([
            "UID:market@x",
            "RECURRENCE-ID;TZID=America/New_York:20260620T090000",
            "SUMMARY:Farmers Market",
            "DTSTART;TZID=America/New_York:20260620T090000",
            "DTEND;TZID=America/New_York:20260620T130000",
            "STATUS:CANCELLED",
          ])
      ),
      W
    );
    // COUNT=5 → 6/6, 6/13, 6/20, 6/27, 7/4; 6/13 is EXDATE'd.
    expect(r.events.map((e) => e.startDate)).toEqual([
      "2026-06-06",
      "2026-06-20",
      "2026-06-27",
      "2026-07-04",
    ]);
    expect(r.events.map((e) => e.externalId)).toContain("market@x::2026-06-20");
    expect(r.events.find((e) => e.startDate === "2026-06-20")!.statusCancelled).toBe(true);
    expect(r.events.filter((e) => e.statusCancelled)).toHaveLength(1);
    expect(r.events.every((e) => e.startTime === "09:00" && e.endTime === "13:00")).toBe(true);
  });

  it("handles MONTHLY ordinals, YEARLY, UNTIL and refuses rule parts it cannot expand", () => {
    const second = parseRrule("FREQ=MONTHLY;BYDAY=2SA;UNTIL=20260930T235959Z", "America/New_York")!;
    expect(expandRrule("2026-06-13", second, "2027-12-31")).toEqual([
      "2026-06-13",
      "2026-07-11",
      "2026-08-08",
      "2026-09-12",
    ]);
    const lastSun = parseRrule("FREQ=MONTHLY;BYDAY=-1SU;COUNT=3", null)!;
    expect(expandRrule("2026-05-31", lastSun, "2027-12-31")).toEqual([
      "2026-05-31",
      "2026-06-28",
      "2026-07-26",
    ]);
    const yearly = parseRrule("FREQ=YEARLY;COUNT=3", null)!;
    expect(expandRrule("2026-08-20", yearly, "2030-12-31")).toEqual([
      "2026-08-20",
      "2027-08-20",
      "2028-08-20",
    ]);
    const r = parseIcsFeed(
      cal(
        vevent([
          "UID:odd",
          "SUMMARY:Odd",
          "DTSTART;VALUE=DATE:20260601",
          "RRULE:FREQ=MONTHLY;BYDAY=SA;BYSETPOS=-1",
        ])
      ),
      W
    );
    expect(r.events).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/BYSETPOS/);
  });
});

describe("LOCATION parsing", () => {
  it("keeps a bare state as state only, so the state-only rule can fire", () => {
    expect(parseLocation("ME")).toEqual({
      name: null,
      address: null,
      city: null,
      state: "ME",
      zip: null,
    });
  });
  it("reads Google's single-line address", () => {
    expect(parseLocation("Fryeburg Fairgrounds, 1154 Main St, Fryeburg, ME 04037, USA")).toEqual({
      name: "Fryeburg Fairgrounds",
      address: "1154 Main St",
      city: "Fryeburg",
      state: "ME",
      zip: "04037",
    });
  });
  it("keeps an unreadable location whole as the name", () => {
    expect(parseLocation("The big field behind the church")?.name).toBe(
      "The big field behind the church"
    );
  });
});

// ------------------------------------------------------------------ JSON-LD

const eventPage = (node: Record<string, unknown>) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [{ "@type": "WebPage", name: "x" }, node],
  })}</script></head><body></body></html>`;

describe("schema.org Event JSON-LD", () => {
  const node = {
    "@type": "Festival",
    name: "Harvest Festival",
    startDate: "2026-09-19T10:00:00-04:00",
    endDate: "2026-09-20T16:00:00-04:00",
    url: "https://grange.org/events/harvest-festival/",
    eventStatus: "https://schema.org/EventScheduled",
    location: {
      "@type": "Place",
      name: "Union Grange Hall",
      address: {
        "@type": "PostalAddress",
        streetAddress: "12 Hall Rd",
        addressLocality: "Union",
        addressRegion: "ME",
        postalCode: "04862",
      },
    },
    offers: { "@type": "Offer", price: "5" },
    organizer: { "@type": "Organization", email: "mailto:Info@grange.org" },
  };

  it("reads an Event subtype inside @graph, keeping the offset's wall time", () => {
    const [ev] = eventsFromHtml(
      eventPage(node),
      "https://grange.org/events/harvest-festival/",
      "America/New_York"
    );
    expect(ev).toMatchObject({
      title: "Harvest Festival",
      startDate: "2026-09-19",
      startTime: "10:00",
      endDate: "2026-09-20",
      endTime: "16:00",
      cost: "$5",
      organizerEmails: ["info@grange.org"],
      statusCancelled: false,
      externalId: "https://grange.org/events/harvest-festival/",
    });
    expect(ev.venue).toEqual({
      name: "Union Grange Hall",
      address: "12 Hall Rd",
      city: "Union",
      state: "ME",
      zip: "04862",
    });
  });

  it("marks EventCancelled and converts a UTC Z time", () => {
    const [ev] = eventsFromHtml(
      eventPage({ ...node, eventStatus: "EventCancelled", startDate: "2026-12-05T15:00:00Z" }),
      "https://grange.org/x",
      "America/New_York"
    );
    expect(ev.statusCancelled).toBe(true);
    expect(ev.startTime).toBe("10:00");
  });

  it("follows a listing page's event links, and a sitemap's", async () => {
    const pages: Record<string, string> = {
      "https://grange.org/events/harvest-festival/": eventPage(node),
      "https://grange.org/events/bean-supper/": eventPage({
        ...node,
        name: "Bean Supper",
        url: "https://grange.org/events/bean-supper/",
      }),
    };
    const fetched: string[] = [];
    const fetchText = async (u: string) => {
      fetched.push(u);
      if (!pages[u]) throw new Error("HTTP 404");
      return pages[u];
    };
    const listing = `<a href="/events/harvest-festival/">a</a><a href="https://grange.org/events/bean-supper/">b</a><a href="https://other.org/events/x/">c</a><a href="/about/">d</a>`;
    const r = await readJsonLdSource("https://grange.org/events/", {
      fetchText,
      startBody: listing,
    });
    expect(r.events.map((e) => e.title).sort()).toEqual(["Bean Supper", "Harvest Festival"]);
    expect(fetched).not.toContain("https://other.org/events/x/");
    expect(r.errors).toEqual([]);

    const sitemap = `<urlset><url><loc>https://grange.org/events/bean-supper/</loc></url><url><loc>https://grange.org/about/</loc></url></urlset>`;
    const s = await readJsonLdSource("https://grange.org/event-sitemap.xml", {
      fetchText,
      startBody: sitemap,
    });
    expect(s.events.map((e) => e.title)).toEqual(["Bean Supper"]);
  });
});

// ------------------------------------------------------------------ pipeline

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const T0 = new Date("2026-03-01T15:00:00Z");
const ICAL_URL = "https://owlshead.org/?ical=1&eventDisplay=list";
const GCAL_URL =
  "https://calendar.google.com/calendar/ical/ohtm.events%40gmail.com/public/basic.ics";

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;
let clock: Date;
let icsBody: string;
let respond: (req: Request) => Response | null;
let fetchLog: Array<{ url: string; inm: string | null }>;

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await server.invoke(name, args)) as Result;
  return {
    isError: !!r.isError,
    text: r.content[0].text,
    body: r.isError ? null : JSON.parse(r.content[0].text),
  };
};
const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  raw.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  raw.prepare(sql).get(...p) as T;
const openFeedRows = () =>
  q<{ event_id: string; divergent_value: string; notes: string; field_class: string }>(
    "SELECT event_id, divergent_value, notes, field_class FROM event_discrepancies WHERE detected_by='organizer_feed' AND resolution_status='open'"
  ).map((r) => ({
    ...r,
    kind: JSON.parse(r.notes).kind as string,
    field: JSON.parse(r.notes).field as string,
  }));

/** OHTM-shaped VEVENTs (same exporter, same property shapes), for the acceptance dates. */
const ohtmEvent = (o: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  desc?: string;
  status?: string;
  url?: string;
}) =>
  vevent([
    `DTSTART;TZID=America/New_York:${o.start}`,
    `DTEND;TZID=America/New_York:${o.end}`,
    "DTSTAMP:20260222T141151Z",
    `UID:${o.uid}`,
    `SUMMARY:${o.summary}`,
    `DESCRIPTION:${o.desc ?? "A museum event."}`,
    `URL:${o.url ?? `https://owlshead.org/event/${o.uid}/`}`,
    "LOCATION:Owls Head Transportation Museum\\, 117 Museum St.\\, Owls Head\\, ME\\, 04854\\, United States",
    'ORGANIZER;CN="Events":MAILTO:events@ohtm.org',
    ...(o.status ? [`STATUS:${o.status}`] : []),
  ]);
const ohtmCal = (events: string) =>
  cal(
    events,
    "X-WR-CALNAME:Owls Head Transportation Museum\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nEND:VTIMEZONE\r\n"
  );

const AIR_SHOW = ohtmEvent({
  uid: "air-show",
  summary: "Wings & Wheels Air Show",
  start: "20260718T090000",
  end: "20260718T160000",
});

beforeEach(() => {
  ({ db, raw } = createTestDb());
  clock = T0;
  fetchLog = [];
  icsBody = ohtmCal(AIR_SHOW);
  respond = () => null;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    fetchLog.push({ url, inm: headers.get("if-none-match") });
    const custom = respond(new Request(url, init));
    if (custom) return custom;
    if (
      headers.get("if-none-match") === '"v1"' &&
      icsBody.includes("air-show") &&
      !icsBody.includes("CHANGED")
    )
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    return new Response(icsBody, {
      status: 200,
      headers: { "content-type": "text/calendar", etag: '"v1"' },
    });
  }) as typeof fetch;

  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')").run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p1','Owls Head Transportation Museum','ohtm','https://owlshead.org')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p2','Other Org','other','https://other.org')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO venues (id, name, slug, city, state) VALUES ('v1','Owls Head Transportation Museum','ohtm-venue','Owls Head','ME')"
    )
    .run();
  const ins = raw.prepare(
    "INSERT INTO events (id, name, slug, promoter_id, venue_id, start_date, end_date, status, source_url) VALUES (?,?,?,'p1','v1',?,?,'APPROVED',?)"
  );
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12) / 1000;
  // The acceptance case: an event we list at the feed's bad 04:30.
  ins.run(
    "e-ac",
    "Junior Inventors",
    "junior-inventors",
    day(2026, 3, 19),
    day(2026, 3, 19),
    "https://owlshead.org/event/junior-inventors/"
  );
  ins.run(
    "e-air",
    "Wings & Wheels Air Show",
    "air-show",
    day(2026, 7, 18),
    day(2026, 7, 18),
    "https://owlshead.org/event/air-show/"
  );
  raw
    .prepare(
      "INSERT INTO event_days (id, event_id, date, open_time, close_time) VALUES ('d-ac','e-ac','2026-03-19','04:30','06:30'), ('d-air','e-air','2026-07-18','09:00','16:00')"
    )
    .run();
  const ts = Math.floor(T0.getTime() / 1000);
  raw
    .prepare(
      "INSERT INTO promoter_contacts (id, promoter_id, name, email, validation_method, status, first_validated_at, last_heard_at, created_at, updated_at) VALUES ('c1','p1','Sammi','events@ohtm.org','domain_verified','validated',?,?,?,?)"
    )
    .run(ts, ts, ts, ts);
  const mail = raw.prepare(
    "INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, sender_auth, body_text, created_at) VALUES (?,?,?,?,?,?,?,?)"
  );
  mail.run(
    "in-gcal",
    ts,
    "Sammi <events@ohtm.org>",
    "submit@meetmeatthefair.com",
    "support",
    "pass",
    `Our calendar: ${GCAL_URL}`,
    ts
  );
  mail.run(
    "in-nourl",
    ts,
    "Sammi <events@ohtm.org>",
    "submit@meetmeatthefair.com",
    "support",
    "pass",
    "No link here",
    ts
  );
  mail.run(
    "in-fail",
    ts,
    "Sammi <events@ohtm.org>",
    "submit@meetmeatthefair.com",
    "support",
    "fail",
    `Our calendar: ${GCAL_URL}`,
    ts
  );
  mail.run(
    "in-stranger",
    ts,
    "someone.calendar@gmail.com",
    "submit@meetmeatthefair.com",
    "support",
    "pass",
    `Our calendar: ${GCAL_URL}`,
    ts
  );

  server = new CapturingMcpServer();
  registerOrganizerFeedTools(server as never, db, ADMIN as never, {
    fetchImpl: fakeFetch,
    now: () => clock,
  });
});

const registerIcal = async (over: Record<string, unknown> = {}) => {
  const r = await call("register_promoter_feed", {
    promoter_id: "p1",
    feed_url: ICAL_URL,
    kind: "ical",
    ...over,
  });
  expect(r.isError, r.text).toBe(false);
  return r.body.feed_id as string;
};
const ingest = (feedId: string, over: Record<string, unknown> = {}) =>
  call("ingest_promoter_feed", {
    feed_id: feedId,
    start_date: "2026-03-01",
    end_date: "2026-12-31",
    dry_run: false,
    ...over,
  });

describe("ownership proof", () => {
  it("admits a feed on the promoter's own domain and records why", async () => {
    const r = await call("register_promoter_feed", {
      promoter_id: "p1",
      feed_url: "webcal://owlshead.org/?ical=1",
      kind: "ical",
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.feed_url).toBe("https://owlshead.org/?ical=1");
    const row = one<{
      ownership_basis: string;
      ownership_evidence: string;
      poll_interval_hours: number;
    }>(
      "SELECT ownership_basis, ownership_evidence, poll_interval_hours FROM promoter_event_feeds WHERE id=?",
      r.body.feed_id
    );
    expect(row.ownership_basis).toBe("domain_list");
    expect(row.ownership_evidence).toContain("owlshead.org");
    expect(row.poll_interval_hours).toBe(6);
  });

  it("refuses a host that is not on the promoter's list", async () => {
    const r = await call("register_promoter_feed", {
      promoter_id: "p2",
      feed_url: ICAL_URL,
      kind: "ical",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not on this promoter's domain list/);
    expect(q("SELECT id FROM promoter_event_feeds")).toHaveLength(0);
  });

  it("a Google calendar needs a validated contact's DMARC-passing message that contains it", async () => {
    expect(isCalendarProviderUrl(GCAL_URL)).toBe(true);
    expect(isCalendarProviderUrl(ICAL_URL)).toBe(false);
    const reasons: string[] = [];
    for (const inbound of [undefined, "in-nourl", "in-fail", "in-stranger"]) {
      const r = await call("register_promoter_feed", {
        promoter_id: "p1",
        feed_url: GCAL_URL,
        kind: "ical",
        inbound_email_id: inbound,
      });
      expect(r.isError).toBe(true);
      reasons.push(r.text);
    }
    expect(reasons[0]).toMatch(/calendar provider/);
    expect(reasons[1]).toMatch(/does not contain this calendar address/);
    expect(reasons[2]).toMatch(/not an aligned DMARC pass/);
    expect(reasons[3]).toMatch(/not a validated contact/);
    const ok = await call("register_promoter_feed", {
      promoter_id: "p1",
      feed_url: GCAL_URL,
      kind: "ical",
      inbound_email_id: "in-gcal",
    });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.body.ownership.basis).toBe("validated_contact");
    expect(
      one<{ ownership_inbound_email_id: string }>(
        "SELECT ownership_inbound_email_id FROM promoter_event_feeds"
      ).ownership_inbound_email_id
    ).toBe("in-gcal");
  });
});

describe("ingest through the OPE-1613 pipeline", () => {
  it("acceptance: OHTM's 2026-03-19 04:30 case raises a discrepancy, in Eastern time", async () => {
    icsBody = ohtmCal(
      ohtmEvent({
        uid: "jr-inventors",
        summary: "Junior Inventors",
        start: "20260319T043000",
        end: "20260319T063000",
        desc: "Jr. Inventor program runs 4:30-6:30 PM.",
        url: "https://owlshead.org/event/junior-inventors/",
      }) + AIR_SHOW
    );
    const feedId = await registerIcal();
    const r = await ingest(feedId);
    expect(r.isError, r.text).toBe(false);
    expect(r.body.outcome).toBe("ingested");
    // no X-WR-TIMEZONE: the reader's default zone; each VEVENT's TZID carried its own
    expect(r.body.read.calendar_tz).toBe("America/New_York");
    const item = r.body.items.find(
      (i: { external_id: string }) => i.external_id === "jr-inventors"
    );
    expect(item).toMatchObject({ event_id: "e-ac", link_basis: "source_url", published: true });
    const rows = openFeedRows().filter((x) => x.event_id === "e-ac");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "am_pm_slip",
      field: "start_time",
      divergent_value: "04:30",
    });
    expect(JSON.parse(rows[0].notes).hint).toBe("16:30");
    // The feed wrote nothing to the event.
    expect(
      one<{ open_time: string }>("SELECT open_time FROM event_days WHERE id='d-ac'").open_time
    ).toBe("04:30");
    expect(one("SELECT count(*) AS n FROM email_send_ledger")).toEqual({ n: 0 });
  });

  it("a cancelled VEVENT raises a cancellation discrepancy, and changes no status", async () => {
    icsBody = ohtmCal(
      ohtmEvent({
        uid: "air-show",
        summary: "Wings & Wheels Air Show",
        start: "20260718T090000",
        end: "20260718T160000",
        status: "CANCELLED",
      })
    );
    const feedId = await registerIcal();
    await ingest(feedId);
    const rows = openFeedRows().filter((x) => x.event_id === "e-air");
    expect(rows.map((x) => [x.kind, x.field, x.field_class])).toEqual([
      ["feed_cancelled", "status", "status"],
    ]);
    expect(JSON.parse(rows[0].notes).question).toMatch(/marks this as cancelled/);
    expect(
      one<{ lifecycle_status: string }>("SELECT lifecycle_status FROM events WHERE id='e-air'")
        .lifecycle_status
    ).toBe("SCHEDULED");
  });

  it("a VEVENT dropped on a later read raises a cancellation discrepancy; its return clears the mark", async () => {
    const feedId = await registerIcal();
    const first = await ingest(feedId);
    expect(first.body.linked).toBe(1);
    expect(openFeedRows()).toHaveLength(0);

    clock = new Date(T0.getTime() + 7 * 3_600_000);
    icsBody = ohtmCal(
      ohtmEvent({
        uid: "other",
        summary: "Car Show CHANGED",
        start: "20260801T090000",
        end: "20260801T150000",
      })
    );
    const second = await ingest(feedId);
    expect(second.body.dropped).toEqual([
      expect.objectContaining({ external_id: "air-show", event_id: "e-air", action: "opened" }),
    ]);
    const rows = openFeedRows().filter((x) => x.event_id === "e-air");
    expect(rows.map((x) => x.kind)).toEqual(["feed_dropped"]);
    expect(
      one<{ missing_since: number | null }>(
        "SELECT missing_since FROM promoter_feed_items WHERE external_id='air-show'"
      ).missing_since
    ).not.toBeNull();

    // Reported once: a third read without it does not re-raise.
    clock = new Date(clock.getTime() + 7 * 3_600_000);
    const third = await ingest(feedId);
    expect(third.body.dropped).toEqual([]);

    // It comes back: the mark clears.
    icsBody = ohtmCal(
      AIR_SHOW +
        ohtmEvent({
          uid: "other",
          summary: "Car Show CHANGED",
          start: "20260801T090000",
          end: "20260801T150000",
        })
    );
    clock = new Date(clock.getTime() + 7 * 3_600_000);
    await ingest(feedId);
    expect(
      one<{ missing_since: number | null }>(
        "SELECT missing_since FROM promoter_feed_items WHERE external_id='air-show'"
      ).missing_since
    ).toBeNull();
  });

  it("a past event falling off the feed is NOT a drop, and neither is a partial read", async () => {
    const feedId = await registerIcal();
    await ingest(feedId);
    // Long after the air show: it is gone from the feed because it happened.
    clock = new Date("2026-08-01T12:00:00Z");
    icsBody = ohtmCal(
      ohtmEvent({
        uid: "later CHANGED",
        summary: "Later",
        start: "20260901T090000",
        end: "20260901T100000",
      })
    );
    // The read window still starts 2026-03-01 (before the show): only the
    // "not before today" floor keeps the finished show from reading as a drop.
    const r = await ingest(feedId);
    expect(r.body.items_read).toBe(1); // positive landmark: the read happened
    expect(r.body.dropped).toEqual([]);
    expect(openFeedRows()).toHaveLength(0);
  });

  it("a later DRY run of an unchanged feed reports no drop (items it carries are not missing)", async () => {
    const feedId = await registerIcal();
    await ingest(feedId);
    clock = new Date(T0.getTime() + 7 * 3_600_000);
    const r = await ingest(feedId, { dry_run: true });
    expect(r.body.items_read).toBe(1);
    expect(r.body.dropped).toEqual([]);
  });

  it("an unchanged feed answers 304 to the stored ETag and does no work", async () => {
    const feedId = await registerIcal();
    await ingest(feedId);
    const actionsBefore = q("SELECT id FROM admin_actions WHERE action='feed.ingested'").length;
    const itemsBefore = q("SELECT last_seen_at FROM promoter_feed_items");
    clock = new Date(T0.getTime() + 6 * 3_600_000);
    const r = await ingest(feedId);
    expect(r.body.outcome).toBe("not_modified");
    expect(r.body.items).toBeUndefined();
    expect(fetchLog.at(-1)!.inm).toBe('"v1"');
    expect(q("SELECT id FROM admin_actions WHERE action='feed.ingested'")).toHaveLength(
      actionsBefore
    );
    expect(q("SELECT last_seen_at FROM promoter_feed_items")).toEqual(itemsBefore);
    const feed = one<{ last_read_status: string; next_read_at: number }>(
      "SELECT last_read_status, next_read_at FROM promoter_event_feeds"
    );
    expect(feed.last_read_status).toBe("not modified (304)");
    expect(feed.next_read_at).toBe(Math.floor(clock.getTime() / 1000) + 6 * 3600);
  });

  it("a dry run sends no validators and writes nothing", async () => {
    const feedId = await registerIcal();
    await ingest(feedId);
    const r = await ingest(feedId, { dry_run: true });
    expect(r.body.outcome).toBe("ingested");
    expect(fetchLog.at(-1)!.inm).toBeNull();
    expect(r.body.next_read_at).toBeNull();
  });

  it("errors back off, doubling per consecutive failure", async () => {
    expect(nextReadDelayMs(6, 0)).toBe(6 * 3_600_000);
    expect(nextReadDelayMs(6, 2)).toBe(24 * 3_600_000);
    expect(nextReadDelayMs(6, 10)).toBe(7 * 86_400_000);
    const feedId = await registerIcal();
    respond = () => new Response("down", { status: 503 });
    const r = await ingest(feedId);
    expect(r.isError).toBe(true);
    const feed = one<{
      consecutive_errors: number;
      next_read_at: number;
      last_read_status: string;
    }>("SELECT consecutive_errors, next_read_at, last_read_status FROM promoter_event_feeds");
    expect(feed.consecutive_errors).toBe(1);
    expect(feed.next_read_at).toBe(Math.floor(T0.getTime() / 1000) + 12 * 3600);
    expect(feed.last_read_status).toMatch(/HTTP 503/);
  });

  it("refuses an HTML page registered as ical, pointing at jsonld", async () => {
    const feedId = await registerIcal();
    respond = () =>
      new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } });
    const r = await ingest(feedId);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/kind 'jsonld'/);
  });
});

describe("scheduled polling", () => {
  it("reads nothing while FEED_POLLING_ENABLED is off, and the due feeds when on", async () => {
    await registerIcal();
    const off = await pollDueFeeds(db as never, {
      now: T0,
      enabled: false,
      fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as never,
    });
    expect(off).toMatchObject({ enabled: false, due: 0, ingested: 0 });

    const calls: string[] = [];
    const ff = (async (u: RequestInfo | URL) => {
      calls.push(String(u));
      return new Response(icsBody, { status: 200, headers: { etag: '"v1"' } });
    }) as typeof fetch;
    const on = await pollDueFeeds(db as never, { now: T0, enabled: true, fetchImpl: ff });
    // positive landmark: exactly the one registered feed was due and read
    expect(on).toMatchObject({ enabled: true, due: 1, ingested: 1, errors: 0 });
    expect(calls).toEqual([ICAL_URL]);
    // Not due again until its interval has passed.
    const again = await pollDueFeeds(db as never, {
      now: new Date(T0.getTime() + 3_600_000),
      enabled: true,
      fetchImpl: ff,
    });
    expect(again.due).toBe(0);
  });
});
