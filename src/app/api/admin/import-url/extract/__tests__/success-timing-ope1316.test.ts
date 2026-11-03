/**
 * OPE-1316 Ask 1 — the extractor times its SUCCESSES, not only its failures.
 *
 * Until now only a failed AI call logged `elapsedMs`, so a new timeout could be
 * sized only against the calls that broke the old one. Every AI answer now
 * writes one `info` row with elapsedMs, contentLength, eventsReturned, url and
 * caller, and the failure row carries the caller too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AI_EXTRACTION_OK_MESSAGE } from "@/lib/url-import/extract-telemetry";

const extractMultipleEvents = vi.fn();
vi.mock("@/lib/url-import/ai-extractor", async (importOriginal) => ({
  // OPE-1316 Ask 2 — keep the real timeout constants the route now reads.
  ...(await importOriginal<typeof import("@/lib/url-import/ai-extractor")>()),
  extractMultipleEvents: (...args: unknown[]) => extractMultipleEvents(...args),
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareAi: () => ({ run: vi.fn() }),
  getCloudflareDb: () => ({}),
}));

type Entry = { level?: string; message?: string; context?: Record<string, unknown> };
const logged: Entry[] = [];
vi.mock("@/lib/logger", () => ({
  logError: async (_db: unknown, entry: Entry) => {
    logged.push(entry);
  },
}));

let sessionUserId: string | null = null;
vi.mock("@/lib/api/with-auth", () => ({
  withAuthorized:
    (
      handler: (ctx: { request: Request; db: unknown; userId: string | null }) => Promise<Response>
    ) =>
    (request: Request) =>
      handler({ request, db: {}, userId: sessionUserId }),
}));

const { POST } = await import("../route");

function post(body: Record<string, unknown>) {
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(
    new Request("https://meetmeatthefair.com/api/admin/import-url/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {}
  );
}

const PAGE = "Heath Fair\nAugust 21-23, 2026\nHeath, MA";
const oneEvent = { name: "Heath Fair", startDate: "2026-08-21", endDate: "2026-08-23" };
const okRows = () => logged.filter((e) => e.message === AI_EXTRACTION_OK_MESSAGE);

beforeEach(() => {
  logged.length = 0;
  sessionUserId = null;
  extractMultipleEvents.mockReset();
});

describe("OPE-1316 — success timing row", () => {
  it("writes ONE info row per AI answer, with the fields a latency distribution needs", async () => {
    extractMultipleEvents.mockResolvedValue({ events: [oneEvent, oneEvent], confidence: {} });
    await post({ content: PAGE, url: "https://www.heathfair.org/", caller: "holdout-sampler" });
    expect(okRows()).toHaveLength(1);
    const [row] = okRows();
    expect(row.level).toBe("info");
    expect(row.context).toMatchObject({
      contentLength: PAGE.length,
      eventsReturned: 2,
      url: "https://www.heathfair.org/",
      caller: "holdout-sampler",
    });
    expect(typeof row.context?.elapsedMs).toBe("number");
  });

  it("an admin session with no caller is recorded as 'admin'; an unnamed internal call says so", async () => {
    extractMultipleEvents.mockResolvedValue({ events: [oneEvent], confidence: {} });
    sessionUserId = "admin-user-001";
    await post({ content: PAGE });
    sessionUserId = null;
    await post({ content: PAGE });
    expect(okRows().map((r) => r.context?.caller)).toEqual(["admin", "internal-unnamed"]);
  });

  it("a FAILED AI call writes no success row, and its failure row now names the caller", async () => {
    extractMultipleEvents.mockRejectedValue(
      new Error("Workers AI multi-event extraction timed out after 20000ms")
    );
    await post({ content: PAGE, caller: "email-workflow" });
    expect(okRows()).toHaveLength(0);
    const failure = logged.find((e) => e.message?.startsWith("AI extraction failed"));
    expect(failure?.context).toMatchObject({
      caller: "email-workflow",
      contentLength: PAGE.length,
    });
  });
});

describe("OPE-1316 Ask 2 — the AI limit follows the caller", () => {
  const limitFor = async (body: Record<string, unknown>, userId: string | null = null) => {
    sessionUserId = userId;
    extractMultipleEvents.mockResolvedValue({ events: [oneEvent], confidence: {} });
    await post({ content: PAGE, ...body });
    return extractMultipleEvents.mock.calls.at(-1)?.[4];
  };

  it("unattended callers (email workflow, free-text, holdout sampler) get 90 s", async () => {
    expect(await limitFor({ caller: "email-workflow" })).toBe(90_000);
    expect(await limitFor({ caller: "email-free-text" })).toBe(90_000);
    expect(await limitFor({ caller: "holdout-sampler" })).toBe(90_000);
  });

  it("the admin import (a person waiting) keeps 20 s, and so does an unnamed caller", async () => {
    expect(await limitFor({}, "u-admin")).toBe(20_000);
    expect(await limitFor({})).toBe(20_000);
    expect(await limitFor({ caller: "photo-intake" })).toBe(20_000);
  });
});
