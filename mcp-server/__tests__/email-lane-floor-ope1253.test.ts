/**
 * OPE-1253 — the email lane created event rows with no start_date, named after
 * link labels, with a newsletter click-tracker as source_url. Specimen:
 * 46d46ee0, a forwarded Maine Made newsletter that produced "Weekly Polls on
 * Facebook" (no date, no venue, source an rs6.net tracker).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailCandidateRefusal,
  isClickTrackerUrl,
  refusalForCandidate,
} from "../src/email-handlers/submit.js";
import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";

const futureDate = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

describe("emailCandidateRefusal", () => {
  it.each([
    ["Weekly Polls on Facebook"],
    ["- YouTube"],
    ["| Facebook"],
    ["Instagram"],
    ["Watch on YouTube"],
    ["Follow us on Instagram"],
    [""],
  ])("refuses the link label / page title %j even with a date", (name) => {
    expect(emailCandidateRefusal({ name, startDate: futureDate(10) })).toBe("non-event-name");
  });
  it("does not refuse real names that merely contain the words", () => {
    expect(
      emailCandidateRefusal({ name: "Watchtower Fall Fair", startDate: futureDate(10) })
    ).toBeNull();
    expect(
      emailCandidateRefusal({ name: "Facebook Marketplace Craft Fair", startDate: futureDate(10) })
    ).toBeNull();
  });
  it("refuses a real name with no start_date", () => {
    expect(emailCandidateRefusal({ name: "VCS Makers Market", startDate: null })).toBe("no-date");
  });
});

describe("refusalForCandidate — after grounding, with OPE-465's one exception", () => {
  it("a date the source never names is dropped, so the candidate is refused", () => {
    const r = refusalForCandidate(
      { event: { name: "Fall Fair", startDate: futureDate(30) } as never },
      ["Our fall fair has crafts and food."]
    );
    expect(r).toBe("no-date");
  });
  it("'details to follow' (the UMF specimen) is NOT refused — created and flagged, per OPE-465", () => {
    const UMF =
      "Thank you for your interest! Information regarding the December Craft Fair will be sent out later this year.";
    const r = refusalForCandidate(
      { event: { name: "UMF December Craft Fair", startDate: null } as never },
      [UMF]
    );
    expect(r).toBeNull();
  });
});

describe("isClickTrackerUrl", () => {
  it("recognises newsletter trackers by host suffix", () => {
    expect(isClickTrackerUrl("https://8m49v68ab.cc.rs6.net/tn.jsp?f=001abc")).toBe(true);
    expect(isClickTrackerUrl("https://click.mlsend.com/link/c/YT0x")).toBe(true);
    expect(isClickTrackerUrl("https://mainemade.us1.list-manage.com/track/click?u=1")).toBe(true);
  });
  it("leaves real pages alone", () => {
    expect(isClickTrackerUrl("https://cumberlandfair.com/")).toBe(false);
    expect(isClickTrackerUrl("https://notrs6.net.example.com/")).toBe(false);
    expect(isClickTrackerUrl("not a url")).toBe(false);
  });
});

// ── 46d46ee0 replayed through the real pipeline ─────────────────────────────
const TRACKER = "https://8m49v68ab.cc.rs6.net/tn.jsp?f=001weekly-polls";
const row = {
  parsedUrl: TRACKER,
  fromAddress: "carolyn@example.com",
  subject: "Fwd: Maine Made October News",
  attachmentCount: 0,
  classifiedSubIntent: "new_event",
  bodyTextExcerpt:
    "---------- Forwarded message ---------\nMaine Made October News. Member giveaway! " +
    `Vote in our Weekly Polls on Facebook ${TRACKER} and win a gift basket. Thanks for being a member.`,
};

function harness(urlEvents: Array<Record<string, unknown>>) {
  const submits: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (u.pathname === "/api/admin/import-url/fetch")
        return Response.json({
          success: true,
          content: "Weekly Polls on Facebook — vote now!",
          fetchMethod: "standard",
        });
      if (u.pathname === "/api/admin/import-url/extract") {
        if (typeof body.url === "string" && body.url)
          return Response.json({
            success: true,
            events: urlEvents,
            count: urlEvents.length,
            extractionMethod: "ai",
          });
        return Response.json({ success: true, events: [], count: 0 });
      }
      if (u.pathname === "/api/suggest-event/check-duplicate")
        return Response.json({ success: true, isDuplicate: false });
      if (u.pathname === "/api/suggest-event/submit") {
        submits.push(body);
        return Response.json({ success: true, event: { id: "e-1", slug: "x" } });
      }
      throw new Error(`unexpected ${u.pathname}`);
    })
  );
  const step = {
    do: async (label: string, a: unknown, b?: unknown) => {
      if (label === "submit/load-row") return row;
      return await ((typeof a === "function" ? a : b) as () => Promise<unknown>)();
    },
  };
  const wf = new (InboundEmailWorkflow as unknown as new (
    c: unknown,
    e: unknown
  ) => {
    runSubmitPipeline: (
      s: unknown,
      id: string
    ) => Promise<{ replyKind: string | null; extractFailReason?: string }>;
  })(
    {},
    {
      DB: {} as D1Database,
      MAIN_APP_URL: "https://app.test",
      INTERNAL_API_KEY: "k",
      EMAIL: undefined,
    }
  );
  return { submits, run: () => wf.runSubmitPipeline(step, "46d46ee0") };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ACCEPTANCE — replaying 46d46ee0 creates zero rows and records why", () => {
  it("the 'Weekly Polls on Facebook' candidate is refused; nothing is submitted", async () => {
    const { submits, run } = harness([{ name: "Weekly Polls on Facebook" }]);
    const r = await run();
    expect(submits).toHaveLength(0);
    expect(r.extractFailReason).toBe("non-event-name");
  });

  it("a real name with no date is refused too (the dateless floor)", async () => {
    const { submits, run } = harness([{ name: "Maine Made Member Mixer" }]);
    const r = await run();
    expect(submits).toHaveLength(0);
    expect(r.extractFailReason).toBe("no-date");
  });
});

describe("submitEvent never stores a click-tracker as source_url", () => {
  it("drops an unresolved tracker URL from the write; a real URL is kept", async () => {
    const { submitEvent } = await import("../src/email-handlers/submit.js");
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return Response.json({ success: true, event: { id: "e-1", slug: "s" } });
      })
    );
    const env = { MAIN_APP_URL: "https://app.test", INTERNAL_API_KEY: "k", DB: {} } as never;
    const ctx = { inboundEmailId: "in-1", dedupWasBlind: false };
    const ev = { name: "Maine Craft Weekend", startDate: futureDate(5) };
    await submitEvent(env, { url: TRACKER, event: ev } as never, "a@b.com", ctx);
    await submitEvent(
      env,
      { url: "https://mainecraftweekend.org/", event: ev } as never,
      "a@b.com",
      ctx
    );
    expect(posted[0].sourceUrl).toBeUndefined();
    expect(posted[1].sourceUrl).toBe("https://mainecraftweekend.org/");
  });
});
