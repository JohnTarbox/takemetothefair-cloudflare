/**
 * OPE-1630 — MCP half of the feed review step:
 *   - the ingest remembers a rejection: a rejected item stays rejected across a
 *     re-read, is never linked (even when its URL matches one of our events),
 *     never re-queued and never asked about;
 *   - list_feed_items / review_feed_item forward to the main app and return a
 *     refusal whole (the suggestion / candidates are the answer).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { ingestFeedItems } from "../src/feeds/ingest.js";
import { registerFeedReviewTools } from "../src/tools/admin-feed-review.js";
import type { FeedEvent } from "@takemetothefair/utils/feeds";

let raw: Database.Database;
let db: TestDb;
const NOW = new Date("2026-11-11T18:00:00Z");
const n = (sql: string, ...p: unknown[]) => (raw.prepare(sql).get(...p) as { n: number }).n;

const item = (o: Partial<FeedEvent>): FeedEvent => ({
  externalId: "x",
  title: "Untitled",
  url: null,
  startDate: "2026-12-17",
  endDate: "2026-12-17",
  startTime: "18:00",
  endTime: "22:00",
  allDay: false,
  timezone: null,
  venue: null,
  organizerEmails: [],
  imageUrl: null,
  description: "",
  categories: [],
  cost: null,
  statusCancelled: false,
  ...o,
});

beforeEach(() => {
  ({ raw, db } = createTestDb());
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p1','Boothbay Railway Village','brv','https://brv.example')"
    )
    .run();
  raw
    .prepare(
      `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
       VALUES ('f1','p1','https://brv.example/wp-json/tribe/events/v1/events','tec_rest',1,1,1)`
    )
    .run();
  // Two events we publish, each matching one feed item by source_url.
  const ev = raw.prepare(
    "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url) VALUES (?,?,?, 'p1', ?, ?, 'APPROVED', ?)"
  );
  const d = Date.UTC(2026, 11, 17, 12) / 1000;
  ev.run(
    "e-party",
    "Bristol Marine Holiday Party",
    "bristol-party",
    d,
    d,
    "https://brv.example/event/party/"
  );
  ev.run(
    "e-express",
    "North Pole Express",
    "north-pole-express",
    d,
    d,
    "https://brv.example/event/npe/"
  );
  // The reviewer's rejection, exactly as review_feed_item writes it.
  raw
    .prepare(
      `INSERT INTO promoter_feed_items (id, feed_id, external_id, title, url, start_local, included, review_state, review_note, reviewed_at, snapshot, first_seen_at, last_seen_at)
       VALUES ('i-party','f1','201','Bristol Marine Holiday Party','https://brv.example/event/party/','2026-12-17',1,'rejected','private event',1,'{}',1,1)`
    )
    .run();
});

describe("a rejection survives a re-read", () => {
  it("stays rejected, unlinked and unasked — while an un-rejected item in the same read links", async () => {
    const report = await ingestFeedItems(db, {
      feedId: "f1",
      items: [
        // Different content from the stored snapshot: the read really updates the row.
        item({
          externalId: "201",
          title: "Bristol Marine Holiday Party",
          url: "https://brv.example/event/party/",
          description: "Changed since last read.",
        }),
        item({
          externalId: "202",
          title: "North Pole Express",
          url: "https://brv.example/event/npe/",
        }),
      ],
      now: NOW,
      dryRun: false,
      actor: "test",
    });
    const byExt = Object.fromEntries(report.items.map((i) => [i.external_id, i]));
    // Positive landmark: the same source_url match DOES link an item nobody rejected.
    expect(byExt["202"]).toMatchObject({
      review_state: "linked",
      event_id: "e-express",
      link_basis: "source_url",
    });
    expect(byExt["201"]).toMatchObject({ review_state: "rejected", event_id: null, findings: [] });
    expect(report.awaiting_review).toBe(0);
    expect(report.linked).toBe(1);
    const row = raw
      .prepare(
        "SELECT review_state, event_id, review_note, snapshot FROM promoter_feed_items WHERE id='i-party'"
      )
      .get() as {
      review_state: string;
      event_id: string | null;
      review_note: string;
      snapshot: string;
    };
    expect(row).toMatchObject({
      review_state: "rejected",
      event_id: null,
      review_note: "private event",
    });
    expect(JSON.parse(row.snapshot).description).toBe("Changed since last read.");
    expect(n("SELECT COUNT(*) n FROM event_discrepancies WHERE event_id='e-party'")).toBe(0);
  });
});

describe("the MCP tools", () => {
  const setup = (response: Response) => {
    const fetch = vi.fn(async (_req: Request) => response);
    const server = new CapturingMcpServer();
    registerFeedReviewTools(
      server as never,
      { role: "ADMIN", userId: "u-admin" } as never,
      {
        MAIN_APP: { fetch: fetch as unknown as typeof globalThis.fetch },
        INTERNAL_API_KEY: "k",
      } as never
    );
    return { server, fetch };
  };

  it("register for admins only", () => {
    const server = new CapturingMcpServer();
    registerFeedReviewTools(server as never, { role: "VENDOR" } as never, {} as never);
    expect([...server.handlers.keys()]).toEqual([]);
  });

  it("review_feed_item forwards one action and returns a refusal whole, as an error", async () => {
    const refusal = {
      ok: false,
      code: "duplicate",
      message: "Already listed.",
      suggest: { action: "link", event_id: "e-express" },
    };
    const { server, fetch } = setup(new Response(JSON.stringify(refusal), { status: 409 }));
    const res = (await server.invoke("review_feed_item", {
      feed_item_id: "i 1",
      action: "approve",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    const req = fetch.mock.calls[0][0] as Request;
    expect(new URL(req.url).pathname).toBe("/api/admin/feed-items/i%201/review");
    expect(req.method).toBe("POST");
    expect(await req.json()).toMatchObject({ action: "approve", actorUserId: "u-admin" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual(refusal);
  });

  it("review_feed_item requires a known action, and forwards nothing otherwise", async () => {
    const { server, fetch } = setup(new Response("{}"));
    const res = (await server.invoke("review_feed_item", {
      feed_item_id: "i1",
      action: "publish",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid arguments for review_feed_item: action/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("list_feed_items passes the filters", async () => {
    const { server, fetch } = setup(new Response(JSON.stringify({ count: 0, items: [] })));
    await server.invoke("list_feed_items", { feed_id: "f1", review_state: "rejected" });
    const url = new URL((fetch.mock.calls[0][0] as Request).url);
    expect(url.pathname).toBe("/api/admin/feed-items");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      feed_id: "f1",
      review_state: "rejected",
    });
  });
});
