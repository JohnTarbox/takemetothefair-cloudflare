/**
 * K23 (Dev-Email-2026-06-13 §B1) — tests for the resubmit_indexnow MCP tool.
 *
 * Covers: explicit-urls mode, from-log mode (pull failures), http_status
 * filter, dedupe + non-host skip, dry_run, max_urls cap, and — the REL4
 * dependency — surfacing the TRUE Bing status when the endpoint 502s on a
 * throttle (so a re-submit isn't reported as a blind "ok").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, indexnowSubmissions } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
});

afterEach(() => {
  mock.restore();
});

interface Payload {
  mode: string;
  candidate_count: number;
  submit_count: number;
  skipped_count: number;
  capped: boolean;
  ok?: boolean;
  bing_http_status?: number;
  note?: string;
  urls_preview?: string[];
}

async function invoke(args: Record<string, unknown> = {}) {
  const result = (await server.invoke("resubmit_indexnow", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { isError: !!result.isError, payload: JSON.parse(result.content[0].text) as Payload };
}

function seedFailure(urls: string[], httpStatus: number | null, ageHours = 1) {
  db.insert(indexnowSubmissions)
    .values({
      id: crypto.randomUUID(),
      timestamp: new Date(Date.now() - ageHours * 3600 * 1000),
      source: "event-update",
      urls: JSON.stringify(urls),
      urlCount: urls.length,
      status: "failure",
      httpStatus: httpStatus ?? undefined,
      errorMessage: httpStatus ? `HTTP ${httpStatus}` : "boom",
    })
    .run();
}

describe("resubmit_indexnow — explicit mode", () => {
  it("submits the given URLs in one batched call and writes an audit row", async () => {
    const { isError, payload } = await invoke({
      urls: ["https://meetmeatthefair.com/events/a", "https://meetmeatthefair.com/events/b"],
    });
    expect(isError).toBe(false);
    expect(payload.mode).toBe("explicit");
    expect(payload.submit_count).toBe(2);
    expect(payload.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].urls.sort()).toEqual([
      "https://meetmeatthefair.com/events/a",
      "https://meetmeatthefair.com/events/b",
    ]);
    expect(mock.calls[0].source).toBe("resubmit-indexnow");

    const audits = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "indexnow.resubmit"))
      .all();
    expect(audits).toHaveLength(1);
  });

  it("dedupes and skips non-host URLs", async () => {
    const { payload } = await invoke({
      urls: [
        "https://meetmeatthefair.com/events/a",
        "https://meetmeatthefair.com/events/a", // dupe
        "https://evil.example.com/x", // off-host → skipped
      ],
    });
    expect(payload.submit_count).toBe(1);
    expect(payload.skipped_count).toBe(1);
    expect(mock.calls[0].urls).toEqual(["https://meetmeatthefair.com/events/a"]);
  });
});

describe("resubmit_indexnow — from-log mode", () => {
  it("pulls distinct failed URLs from indexnow_submissions within the window", async () => {
    seedFailure(["https://meetmeatthefair.com/events/x"], 429, 1);
    seedFailure(["https://meetmeatthefair.com/events/x"], 429, 2); // dupe URL
    seedFailure(["https://meetmeatthefair.com/venues/y"], 500, 3);
    seedFailure(["https://meetmeatthefair.com/events/old"], 429, 48); // outside 24h window

    const { payload } = await invoke({ since_hours: 24 });
    expect(payload.mode).toBe("from_log");
    expect(payload.submit_count).toBe(2); // x + y, deduped, old excluded
    expect(mock.calls[0].urls.sort()).toEqual([
      "https://meetmeatthefair.com/events/x",
      "https://meetmeatthefair.com/venues/y",
    ]);
  });

  it("http_status filter narrows to a single Bing status", async () => {
    seedFailure(["https://meetmeatthefair.com/events/throttled"], 429, 1);
    seedFailure(["https://meetmeatthefair.com/events/badreq"], 422, 1);

    const { payload } = await invoke({ since_hours: 24, http_status: 429 });
    expect(payload.submit_count).toBe(1);
    expect(mock.calls[0].urls).toEqual(["https://meetmeatthefair.com/events/throttled"]);
  });

  it("reports no eligible URLs without calling IndexNow when the log is clean", async () => {
    const { payload } = await invoke({ since_hours: 24 });
    expect(payload.submit_count).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("resubmit_indexnow — dry_run + cap", () => {
  it("dry_run previews the set without calling IndexNow or auditing", async () => {
    const { payload } = await invoke({
      urls: ["https://meetmeatthefair.com/events/a"],
      dry_run: true,
    });
    expect(payload.submit_count).toBe(1);
    expect(payload.urls_preview).toEqual(["https://meetmeatthefair.com/events/a"]);
    expect(mock.calls).toHaveLength(0);
    const audits = db.select().from(adminActions).all();
    expect(audits).toHaveLength(0);
  });

  it("caps at max_urls and flags capped=true", async () => {
    const { payload } = await invoke({
      urls: [
        "https://meetmeatthefair.com/events/a",
        "https://meetmeatthefair.com/events/b",
        "https://meetmeatthefair.com/events/c",
      ],
      max_urls: 2,
    });
    expect(payload.submit_count).toBe(2);
    expect(payload.capped).toBe(true);
  });
});

describe("resubmit_indexnow — REL4: true Bing status on throttle", () => {
  it("reports ok:false + the real 429 status when the endpoint 502s", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, indexnow_http_status: 429, error: "HTTP 429" }),
        { status: 502 }
      )) as typeof fetch;
    try {
      const { isError, payload } = await invoke({
        urls: ["https://meetmeatthefair.com/events/a"],
      });
      expect(isError).toBe(true);
      expect(payload.ok).toBe(false);
      expect(payload.bing_http_status).toBe(429);
      expect(payload.note).toContain("re-run");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
