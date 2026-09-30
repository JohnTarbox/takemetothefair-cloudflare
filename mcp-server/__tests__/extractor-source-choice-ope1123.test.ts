/**
 * OPE-1123 — the submit extractor chose the wrong TEXT inside an email.
 *
 * Both specimens replayed through `runSubmitPipeline` with every main-app
 * endpoint mocked — send-free, no prod rows touched (the ack path sends mail).
 *
 *   09eccd4f — a reply's QUOTED transcript fed to the extractor as live prose:
 *              the four-month-old June 21 message minted a row for a past
 *              event beside the Oct 11 one the live text was about.
 *   2fca1d1d — two thomas.edu LISTING pages minted "events" named after the
 *              page ("Upcoming Events: Thomas College, …") beside the real
 *              Thomas College Craft Fair from the body prose.
 *
 * The /extract mock for body prose EXTRACTS WHAT IT IS SHOWN, like the real
 * one: it returns the June event only if the June text reaches it. So the
 * assertion is on the mechanism — what the extractor was given — not on a
 * downstream gate that might have caught it for another reason.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlug } from "@takemetothefair/utils";
import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";
import { submissionProseText } from "../src/email-handlers/strip-quoted-reply.js";
import {
  isListingPageTitle,
  listingCandidatesToDrop,
} from "../src/email-handlers/listing-page-title.js";

interface RowSnapshot {
  parsedUrl: string | null;
  fromAddress: string;
  subject: string;
  attachmentCount: number;
  classifiedSubIntent: string | null;
  bodyTextExcerpt: string | null;
}

function makeStep(row: RowSnapshot) {
  const step = {
    do: async (label: string, optsOrFn: unknown, maybeFn?: unknown) => {
      if (label === "submit/load-row") return row;
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return await fn();
    },
  };
  return { step };
}

function makeWorkflow() {
  const env = {
    DB: {} as unknown as D1Database,
    MAIN_APP_URL: "https://app.test",
    INTERNAL_API_KEY: "test-key",
    EMAIL: undefined,
  };
  return new (InboundEmailWorkflow as unknown as new (
    ctx: unknown,
    env: unknown
  ) => {
    runSubmitPipeline: (step: unknown, id: string) => Promise<{ replyKind: string | null }>;
  })({}, env);
}

const futureDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function installFetch(cfg: {
  urlEvents: Record<string, Array<Record<string, unknown>>>;
  bodyExtract: (content: string) => Array<Record<string, unknown>>;
}) {
  const created: string[] = [];
  const bodyContents: string[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const body =
      init && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    if (u.pathname === "/api/admin/import-url/fetch") {
      const target = u.searchParams.get("url") ?? "";
      return Response.json({
        success: true,
        content: `CONTENT_FOR:${target}`,
        fetchMethod: "standard",
      });
    }
    if (u.pathname === "/api/admin/import-url/extract") {
      if (typeof body.url === "string" && body.url.length > 0) {
        const events = cfg.urlEvents[body.url] ?? [];
        return Response.json({
          success: true,
          events,
          count: events.length,
          extractionMethod: "ai",
        });
      }
      const content = String(body.content ?? "");
      bodyContents.push(content);
      const events = cfg.bodyExtract(content);
      return Response.json({ success: true, events, count: events.length });
    }
    if (u.pathname === "/api/suggest-event/check-duplicate") {
      return Response.json({ success: true, isDuplicate: false });
    }
    if (u.pathname === "/api/suggest-event/submit") {
      const name = String(body.name ?? "unnamed");
      created.push(name);
      return Response.json({
        success: true,
        event: { id: `e-${createSlug(name)}`, slug: createSlug(name) },
      });
    }
    throw new Error(`unexpected fetch to ${u.pathname}`);
  };
  vi.stubGlobal("fetch", vi.fn(impl as typeof fetch));
  return { created, bodyContents };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** inbound 09eccd4f, verbatim (blank-line runs condensed). */
const HACKMATACK =
  "Hi Carolyn,\n\nHope you're doing well! I wanted to confirm if you'll be joining us at " +
  "Hackmatack for our fall festival on October 11th? We'd love to have you! Please let me " +
  "know, Thank you!\n\nBest,\n\nAram\n\nhttps://www.hackmatackplayhouse.org/\n\n" +
  "Aram Guptill | Executive Producer\n\nHackmatack Farm + Playhouse\n\n~ (207) 698-1807\n\n" +
  "~ 538 School Street, Berwick, ME 03901\n\n\n\n" +
  'From: Aram Guptill <aram@hackmatack.org>\nTo: "colors"<colors@symdak.com>\n' +
  "Date: Thu, 14 May 2026 08:23:19 -0400\nSubject: Hackmatack Open Farm Day- June 21st\n\n" +
  "Hello Carolyn\n\nI hope you're doing well! Thank you for reaching out to be a part of our " +
  "craft + community fair at Hackmatack. Some logistics: I have you down as being interested " +
  "in both our June 21 and Oct 11 event. The first open farm day craft fair is on Sunday June " +
  "21st with a rain date scheduled for Sunday June 28th. The event runs from 10-3pm. There is " +
  "a $20 vendor fee for artisans.\n\nThank you,\n\nAram";

/** inbound 2fca1d1d, verbatim. */
const THOMAS =
  "The upcoming Thomas College Craft Fair takes place on Saturday, September\n26, 2026, from " +
  "9:00 AM to 3:00 PM EDT at Thomas College\n<https://www.thomas.edu/upcoming-events/> in " +
  "Waterville, Maine. [1\n<https://www.thomas.edu/upcoming-events/>, 2\n" +
  "<https://www.facebook.com/events/thomas-college/thomas-college-craft-fair/2312333862504805/>\n]\n" +
  "Event Details\n\n   - Event Name: Thomas College Craft Fair\n   - Date & Time: Saturday, " +
  "September 26, 2026, from 9:00 AM – 3:00 PM\n   - Venue & Address: Thomas College Field House\n" +
  "      <https://www.thomas.edu/campus-life/campus-operations/event-and-conference-services/events-happening-on-campus/>,\n" +
  "      180 West River Rd., Waterville, ME 04901\n";

describe("OPE-1123 specimen 2 — quoted history is not a source", () => {
  it("ACCEPTANCE: the extractor is never shown the quoted June 21 transcript", async () => {
    const { created, bodyContents } = installFetch({
      urlEvents: {},
      // Extracts what it is shown: the June event exists only if June reaches it.
      bodyExtract: (content) => [
        {
          name: "Hackmatack Fall Festival",
          startDate: futureDate(18),
          venueName: "Hackmatack Farm",
        },
        ...(/June 21/.test(content)
          ? [
              {
                name: "Hackmatack Open Farm Day",
                startDate: futureDate(40),
                venueName: "Hackmatack Farm",
              },
            ]
          : []),
      ],
    });
    const { step } = makeStep({
      parsedUrl: null,
      fromAddress: "shpandabear10@gmail.com",
      subject: "",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      bodyTextExcerpt: HACKMATACK,
    });

    await makeWorkflow().runSubmitPipeline(step, "row-1");

    expect(bodyContents.length).toBeGreaterThan(0);
    for (const c of bodyContents) {
      expect(c).toMatch(/October 11th/);
      expect(c).not.toMatch(/June 21/);
    }
    expect(created).toEqual(["Hackmatack Fall Festival"]);
  });
});

describe("OPE-1123 specimen 1 — a listing page is not an event", () => {
  it("ACCEPTANCE: only the Thomas College Craft Fair is created", async () => {
    const { created } = installFetch({
      urlEvents: {
        "https://www.thomas.edu/upcoming-events/": [
          { name: "Upcoming Events: Thomas College, Waterville, Maine", startDate: futureDate(2) },
        ],
        "https://www.thomas.edu/campus-life/campus-operations/event-and-conference-services/events-happening-on-campus/":
          [{ name: "Events Happening on Campus: Thomas College: Maine", startDate: futureDate(2) }],
      },
      bodyExtract: () => [
        {
          name: "Thomas College Craft Fair",
          startDate: futureDate(3),
          venueName: "Thomas College Field House",
        },
      ],
    });
    const { step } = makeStep({
      parsedUrl: "https://www.thomas.edu/upcoming-events/",
      fromAddress: "jtarboxme@gmail.com",
      subject: "Thomas College Craft Fair",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      bodyTextExcerpt: THOMAS,
    });

    await makeWorkflow().runSubmitPipeline(step, "row-1");

    expect(created).toEqual(["Thomas College Craft Fair"]);
  });
});

describe("submissionProseText keeps a forward's payload", () => {
  const quoted =
    "From: Org <o@x.org>\nTo: me <m@y.com>\nDate: Thu\nSubject: Fair\n\nOur fair is June 21.";

  it("cuts a reply transcript when the live text names a date", () => {
    const body = `See you at the fall fair on October 11th!\n\n${quoted}`;
    expect(submissionProseText(body, "")).not.toMatch(/June 21/);
  });

  it("keeps everything under a Fwd:/FW: subject — an Outlook forward has no delimiter", () => {
    const body = `Please add this one, Oct 3 works for us.\n\n${quoted}`;
    expect(submissionProseText(body, "FW: Fair")).toBe(body);
    expect(submissionProseText(body, "Fwd: Fair")).toBe(body);
  });

  it("keeps everything when the live text names no date — the quote may be the payload", () => {
    const body = `Please add this fair to your site, thanks!\n\n${quoted}`;
    expect(submissionProseText(body, "")).toBe(body);
  });

  it("keeps a Gmail forward, delimiter and all", () => {
    const body = `FYI for Oct 3\n\n---------- Forwarded message ---------\n${quoted}`;
    expect(submissionProseText(body, "")).toBe(body);
  });
});

describe("the listing-title rule is narrow", () => {
  it("matches the specimen page titles and not real event names", () => {
    expect(isListingPageTitle("Upcoming Events: Thomas College, Waterville, Maine")).toBe(true);
    expect(isListingPageTitle("Events Happening on Campus: Thomas College: Maine")).toBe(true);
    expect(isListingPageTitle("Thomas College Craft Fair")).toBe(false);
    expect(isListingPageTitle("Upcoming Craft Fair at the Grange")).toBe(false);
    expect(isListingPageTitle("Calendar Girls Holiday Market")).toBe(false);
  });

  it("drops only URL candidates, and never the last one standing", () => {
    const listing = "Upcoming Events: Town Hall";
    expect(
      listingCandidatesToDrop([
        { name: listing, kind: "url" },
        { name: "Town Fair", kind: "body" },
      ])
    ).toEqual([0]);
    expect(listingCandidatesToDrop([{ name: listing, kind: "url" }])).toEqual([]);
    expect(
      listingCandidatesToDrop([
        { name: listing, kind: "body" },
        { name: "Town Fair", kind: "url" },
      ])
    ).toEqual([]);
  });
});
