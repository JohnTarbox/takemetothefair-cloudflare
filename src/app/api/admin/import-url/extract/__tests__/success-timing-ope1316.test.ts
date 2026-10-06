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
vi.mock("@/lib/url-import/ai-extractor", () => ({
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
