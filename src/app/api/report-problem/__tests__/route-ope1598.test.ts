import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: Record<string, unknown>[] = [];
const correlation = vi.fn(async () => new Response("{}", { status: 200 }));

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserted.push(row);
      },
    }),
  }),
  getCloudflareEnv: () => ({ INTERNAL_API_KEY: "k", MCP_SERVER_URL: "https://mcp.example" }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: vi.fn(() => new Response("limited", { status: 429 })),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ ctx: { waitUntil: () => undefined } }),
}));

import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";

function post(body: string, website = ""): Request {
  const form = new FormData();
  form.set("body", body);
  form.set("website", website);
  return new Request("https://meetmeatthefair.com/api/report-problem", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  inserted.length = 0;
  correlation.mockClear();
  vi.stubGlobal("fetch", correlation);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/report-problem", () => {
  it("stores a replayed scanner payload resolved, so the open count does not move", async () => {
    const res = await POST(post("' ORDER BY 1000-- -"));
    expect(res.status).toBe(303);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: "spam" });
    expect(inserted[0].resolvedAt).toBeInstanceOf(Date);
    expect(correlation).not.toHaveBeenCalled();
  });

  it("leaves a real report open and runs correlation", async () => {
    const res = await POST(post("The dates are wrong on this event page."));
    expect(res.status).toBe(303);
    expect(inserted[0].kind).toBeUndefined();
    expect(inserted[0].resolvedAt).toBeUndefined();
    await vi.waitFor(() => expect(correlation).toHaveBeenCalledTimes(1));
  });

  it("writes nothing when the honeypot is filled or the limit is hit", async () => {
    await POST(post("A real sentence here.", "http://spam.example"));
    expect(inserted).toHaveLength(0);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(post("A real sentence here."));
    expect(res.status).toBe(429);
    expect(inserted).toHaveLength(0);
  });
});
