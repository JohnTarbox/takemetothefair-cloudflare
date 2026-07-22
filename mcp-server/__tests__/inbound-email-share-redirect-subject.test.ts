/**
 * OPE-277 — two intake recoveries in the multi-source fan-out that the
 * single-source path already had but the fan-out (OPE-55) never got:
 *
 *   1. SHARE-REDIRECT recovery. A share/redirect host (share.google / g.co /
 *      youtu.be / fb.me) 429s server-side fetchers before emitting its redirect,
 *      so `submitFetch` throws. OPE-193 wired a one-hop manual-redirect recovery
 *      into the single-source path only; the fan-out died at `fetch-failed`,
 *      losing two real submissions on 2026-07-19/20. This test drives the
 *      fan-out with a share.google source whose direct fetch 500s but whose
 *      manual-redirect hop resolves to a real page, and asserts the event is
 *      created from the resolved page.
 *
 *   2. SUBJECT-LINE fallback. When no source (URL fetch / body prose) yields an
 *      extractable event, the SUBJECT often still carries it ("Maine Lobster
 *      Festival … Rockland, Maine"). This test drives a submission whose URL
 *      fetch fails, whose body prose extracts nothing, and whose subject carries
 *      a full event, and asserts the subject salvages it.
 *
 * Harness mirrors inbound-email-multi-source.test.ts: a `step.do` mock runs each
 * step body inline and short-circuits `submit/load-row` to a synthetic row; a
 * stubbed global `fetch` emulates the main-app endpoints AND the direct
 * manual-redirect hop that resolveShareRedirect makes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlug } from "@takemetothefair/utils";
import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";

interface RowSnapshot {
  parsedUrl: string | null;
  fromAddress: string;
  subject: string;
  attachmentCount: number;
  classifiedSubIntent: string | null;
  bodyTextExcerpt: string | null;
}

function makeStep(row: RowSnapshot) {
  const labels: string[] = [];
  const step = {
    do: async (label: string, optsOrFn: unknown, maybeFn?: unknown) => {
      labels.push(label);
      if (label === "submit/load-row") return row;
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return await fn();
    },
  };
  return { step, labels };
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
    runSubmitPipeline: (
      step: unknown,
      id: string
    ) => Promise<{
      replyKind: string | null;
      replyParams?: Record<string, unknown>;
      status: string;
      resultingEventId?: string | null;
    }>;
  })({}, env);
}

const slugify = (s: string): string => createSlug(s);

interface MockCfg {
  /** share host → the Location it 302-redirects to (manual-redirect hop). null = no redirect (200). */
  shareRedirect?: Record<string, string | null>;
  /** fetch-target substrings that should 500 (fetch-failed). */
  failFetch?: string[];
  /** target-url → events[] the /extract endpoint returns for that URL. */
  urlEvents?: Record<string, Array<Record<string, unknown>>>;
  /** free-text (no-url) /extract: match on a substring of `content` → events[]. */
  freeTextEvents?: Array<{ contains: string; events: Array<Record<string, unknown>> }>;
}

function installFetch(cfg: MockCfg) {
  const created: string[] = [];
  const submitBodies: Array<Record<string, unknown>> = [];

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input.toString();
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();

    // Direct manual-redirect hop from resolveShareRedirect (not a main-app path).
    if (init?.redirect === "manual") {
      const loc = cfg.shareRedirect?.[host];
      if (loc) return new Response(null, { status: 302, headers: { location: loc } });
      return new Response(null, { status: 200 }); // no redirect → resolve returns null
    }

    const path = u.pathname;
    const body =
      init && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    if (path === "/api/admin/import-url/fetch") {
      const target = u.searchParams.get("url") ?? "";
      if ((cfg.failFetch ?? []).some((s) => target.includes(s))) {
        return new Response("upstream down", { status: 500 });
      }
      return Response.json({
        success: true,
        content: `CONTENT_FOR:${target}`,
        fetchMethod: "standard",
      });
    }

    if (path === "/api/admin/import-url/extract") {
      if (typeof body.url === "string" && body.url.length > 0) {
        const events = cfg.urlEvents?.[body.url] ?? [];
        return Response.json({
          success: true,
          events,
          count: events.length,
          extractionMethod: "ai",
        });
      }
      const content = typeof body.content === "string" ? body.content : "";
      const match = (cfg.freeTextEvents ?? []).find((m) => content.includes(m.contains));
      const events = match?.events ?? [];
      return Response.json({ success: true, events, count: events.length });
    }

    if (path === "/api/suggest-event/check-duplicate") {
      return Response.json({ success: true, isDuplicate: false });
    }

    if (path === "/api/suggest-event/submit") {
      submitBodies.push(body);
      const name = typeof body.name === "string" ? body.name : "unnamed";
      created.push(name);
      return Response.json({
        success: true,
        event: { id: `e-${slugify(name)}`, slug: slugify(name) },
      });
    }

    throw new Error(`unexpected fetch to ${path} (host ${host})`);
  };

  vi.stubGlobal("fetch", vi.fn(impl as typeof fetch));
  return { created, submitBodies };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("OPE-277 — share-redirect recovery in the multi-source fan-out", () => {
  it("recovers a share.google source via a manual-redirect hop and creates the event", async () => {
    const share = "https://share.google/aHREq0ggVr16Ttp8w";
    const resolved = "https://mainelobsterfestival.com/";
    const row: RowSnapshot = {
      parsedUrl: share,
      fromAddress: "fan@example.com",
      subject: "no event here",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      // >20 chars + a URL → enters the multi-source pipeline; prose carries no event.
      bodyTextExcerpt: `Please add the event at this link ${share} — thanks so much!`,
    };
    const { created } = installFetch({
      failFetch: ["share.google"], // the direct share fetch 500s (stands in for the 429)
      shareRedirect: { "share.google": resolved },
      urlEvents: {
        [resolved]: [
          { name: "Maine Lobster Festival", startDate: "2026-08-05", venueName: "Rockland" },
        ],
      },
      freeTextEvents: [], // body prose extracts nothing
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    expect(created).toEqual(["Maine Lobster Festival"]);
    expect(labels).toContain("submit/multi[0]/resolve-share-redirect");
    expect(labels).toContain("submit/multi[0]/fetch-resolved-url");
    // recovery produced a candidate → subject fallback must NOT run.
    expect(labels).not.toContain("submit/subject/extract");
    expect(result.status).toBe("replied");
  });

  it("falls through to fetch-failed when the share link does not redirect", async () => {
    const share = "https://share.google/deadlink";
    const row: RowSnapshot = {
      parsedUrl: share,
      fromAddress: "fan@example.com",
      subject: "still no event",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      bodyTextExcerpt: `Here is the link ${share} for the thing, please take a look now.`,
    };
    const { created } = installFetch({
      failFetch: ["share.google"],
      shareRedirect: { "share.google": null }, // 200, no Location → resolve returns null
      freeTextEvents: [],
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    expect(created).toEqual([]);
    expect(labels).toContain("submit/multi[0]/resolve-share-redirect");
    expect(labels).not.toContain("submit/multi[0]/fetch-resolved-url");
    // No attachments → the bounce is the plain no-url ask (not the prose-failed variant).
    expect(result.replyKind).toBe("no-url");
  });
});

describe("OPE-277 — subject-line fallback source", () => {
  it("salvages the event from the SUBJECT when URL + body yield nothing", async () => {
    const share = "https://share.google/TLed3ziQ5LeX4g9T2";
    const row: RowSnapshot = {
      parsedUrl: share,
      fromAddress: "fan@example.com",
      // subject carries the whole event; body does not name it.
      subject: "Maine Lobster Festival on August 5 2026 in Rockland Maine",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      bodyTextExcerpt: `Forwarding you the link at ${share} for your calendar, cheers.`,
    };
    const { created, submitBodies } = installFetch({
      failFetch: ["share.google"],
      shareRedirect: { "share.google": null }, // no redirect recovery → isolate the subject path
      freeTextEvents: [
        {
          contains: "Maine Lobster Festival",
          events: [
            { name: "Maine Lobster Festival", startDate: "2026-08-05", venueName: "Rockland" },
          ],
        },
      ],
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    expect(labels).toContain("submit/subject/extract");
    expect(created).toEqual(["Maine Lobster Festival"]);
    // body-sourced provenance → no sourceUrl leaks onto the created event.
    expect(submitBodies[0]?.sourceUrl).toBeUndefined();
    expect(result.status).toBe("replied");
  });

  it("does NOT run the subject extract when a source already produced a candidate", async () => {
    const url = "https://realfair.example/events";
    const row: RowSnapshot = {
      parsedUrl: url,
      fromAddress: "fan@example.com",
      subject: "Some Other Festival 2026",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      bodyTextExcerpt: `Full details for our fair are at ${url} — please list it, thank you!`,
    };
    const { created } = installFetch({
      urlEvents: {
        [url]: [{ name: "Real Fair", startDate: "2026-09-01", venueName: "Town Green" }],
      },
      freeTextEvents: [],
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    await wf.runSubmitPipeline(step, "row-1");

    expect(created).toContain("Real Fair");
    expect(labels).not.toContain("submit/subject/extract");
  });
});
