/**
 * OPE-1630 — the feed review step: approve / approve_as_occurrence / link /
 * reject on a promoter_feed_items row, against the MCP suite's full schema (the
 * real 0406/0409/0413/0414 DDL), plus the list read and the routes' gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../../mcp-server/__tests__/setup-db";
import type { FeedEvent } from "@takemetothefair/utils/feeds";

let raw: Database.Database;
let db: ReturnType<typeof createTestDb>["db"];
let authorized = true;
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/server-analytics", () => ({ trackEventStatusChange: vi.fn(async () => {}) }));
vi.mock("@/lib/api-auth", () => ({
  internalKeyMatches: () => false,
  getAuthorizedSession: vi.fn(async () =>
    authorized ? { authorized: true, userId: "u-admin" } : { authorized: false }
  ),
}));

import { listFeedItems, reviewFeedItem, type ReviewInput } from "../review";
import { GET as listGet } from "@/app/api/admin/feed-items/route";
import { POST as reviewPost } from "@/app/api/admin/feed-items/[id]/review/route";

const NOW = new Date("2026-11-11T18:00:00Z");
const n = (sql: string, ...p: unknown[]) => (raw.prepare(sql).get(...p) as { n: number }).n;
const one = <T>(sql: string, ...p: unknown[]) => raw.prepare(sql).get(...p) as T;

const feedEvent = (o: Partial<FeedEvent>): FeedEvent => ({
  externalId: "x",
  title: "Untitled",
  url: null,
  startDate: "2026-12-13",
  endDate: "2026-12-13",
  startTime: "09:00",
  endTime: "14:00",
  allDay: false,
  timezone: "America/New_York",
  venue: {
    name: "Bath Middle School",
    address: "6 Old Brunswick Rd",
    city: "Bath",
    state: "ME",
    zip: "04530",
  },
  organizerEmails: [],
  imageUrl: null,
  description: "Fifty dealers of antiques and collectibles.",
  categories: [],
  cost: null,
  statusCancelled: false,
  ...o,
});

function seedItem(id: string, ev: FeedEvent, state = "awaiting_review") {
  raw
    .prepare(
      `INSERT INTO promoter_feed_items (id, feed_id, external_id, title, url, start_local, included, review_state, snapshot, first_seen_at, last_seen_at)
       VALUES (?, 'f-g', ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    )
    .run(id, ev.externalId, ev.title, ev.url, ev.startDate, state, JSON.stringify(ev), 1, 1);
}

const review = (o: Partial<ReviewInput> & Pick<ReviewInput, "feedItemId" | "action">) =>
  reviewFeedItem(db as never, { actorUserId: "u-admin", now: NOW, ...o });

beforeEach(() => {
  ({ raw, db } = createTestDb());
  authorized = true;
  // Prod's event_days key (drizzle/0299) — the shared upsert targets it; the harness omits it.
  raw.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_days_event_date_vendor ON event_days(event_id, date, vendor_only)"
  );
  raw
    .prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@example.org','ADMIN')")
    .run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p-g','Gurley Antique Shows','gurley','https://gurley.example')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO venues (id, name, slug, city, state) VALUES ('v-bath','Bath Middle School','bath-middle-school','Bath','ME'), ('v-dover','Dover Elks Lodge','dover-elks-lodge','Dover','NH')"
    )
    .run();
  raw
    .prepare(
      `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
       VALUES ('f-g','p-g','https://gurley.example/wp-json/tribe/events/v1/events','tec_rest',1,1,1)`
    )
    .run();
  // An event we already list (the dedup case).
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, venue_id, start_date, end_date, status) VALUES ('e-tsg','The Thanksgiving Sunday Antique Show','thanksgiving-sunday-antique-show-2026','p-g','v-bath',?,?,'APPROVED')"
    )
    .run(Date.UTC(2026, 10, 29, 12) / 1000, Date.UTC(2026, 10, 29, 12) / 1000);
  raw
    .prepare(
      "INSERT INTO event_series (id, canonical_slug, name, venue_id, promoter_id) VALUES ('s-dover','dover-wednesday-antiques-market','The Dover Wednesday Antiques Market','v-dover','p-g')"
    )
    .run();

  seedItem(
    "i-bath1",
    feedEvent({
      externalId: "101",
      title: "The Bath Antique Sale",
      url: "https://gurley.example/event/bath-1/",
    })
  );
  seedItem(
    "i-bath2",
    feedEvent({
      externalId: "102",
      title: "The Bath Antique Sale",
      url: "https://gurley.example/event/bath-2/",
      startDate: "2027-01-10",
      endDate: "2027-01-10",
    })
  );
  seedItem(
    "i-novenue",
    feedEvent({
      externalId: "103",
      title: "Winter Antique Show",
      venue: { name: "Nowhere Hall", address: null, city: "Bath", state: "ME", zip: null },
    })
  );
  seedItem(
    "i-wedding",
    feedEvent({
      externalId: "104",
      title: "Teele Wedding",
      startDate: "2026-11-21",
      endDate: "2026-11-21",
    })
  );
  seedItem(
    "i-tsg",
    feedEvent({
      externalId: "105",
      title: "The Thanksgiving Sunday Antique Show",
      startDate: "2026-11-29",
      endDate: "2026-11-29",
      url: "https://gurley.example/event/tsg/",
    })
  );
  seedItem(
    "i-flea",
    feedEvent({
      externalId: "106",
      title: "The Dover Wednesday Flea Market",
      startDate: "2026-12-02",
      endDate: "2026-12-02",
      venue: { name: "Dover Elks Lodge", address: null, city: "Dover", state: "NH", zip: null },
    })
  );
});

describe("approve", () => {
  it("creates the listing through the import writer, cites every value to the item, links it, audits it", async () => {
    const r = await review({ feedItemId: "i-bath1", action: "approve" });
    expect(r).toMatchObject({ ok: true, review_state: "linked", event: { status: "APPROVED" } });
    if (!r.ok) throw new Error("unreachable");
    const ev = one<{ venue_id: string; promoter_id: string; name: string; status: string }>(
      "SELECT venue_id, promoter_id, name, status FROM events WHERE id=?",
      r.event!.id
    );
    expect(ev).toEqual({
      venue_id: "v-bath",
      promoter_id: "p-g",
      name: "The Bath Antique Sale",
      status: "APPROVED",
    });
    // Provenance: every citation is the feed's rung, pointing at the item URL.
    const cites = raw
      .prepare(
        "SELECT field_name, provenance_kind, source_url, notes FROM event_data_citations WHERE event_id=?"
      )
      .all(r.event!.id) as Array<{
      field_name: string;
      provenance_kind: string;
      source_url: string;
      notes: string;
    }>;
    expect(cites.map((c) => c.field_name)).toEqual(
      expect.arrayContaining(["name", "start_date", "venue"])
    );
    for (const c of cites) {
      expect(c.provenance_kind).toBe("feed");
      expect(c.source_url).toBe("https://gurley.example/event/bath-1/");
      expect(JSON.parse(c.notes)).toMatchObject({ feed_item_id: "i-bath1", external_id: "101" });
    }
    expect(
      one("SELECT review_state, event_id, reviewed_by FROM promoter_feed_items WHERE id='i-bath1'")
    ).toEqual({
      review_state: "linked",
      event_id: r.event!.id,
      reviewed_by: "u-admin",
    });
    expect(
      n(
        "SELECT COUNT(*) n FROM admin_actions WHERE action='feed_item.approve' AND target_id='i-bath1'"
      )
    ).toBe(1);
  });

  it("a second date of the same show joins the same series; approving twice is refused", async () => {
    const a = await review({ feedItemId: "i-bath1", action: "approve" });
    const b = await review({ feedItemId: "i-bath2", action: "approve" });
    if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
    expect(a.event!.series_id).toBeTruthy();
    expect(b.event!.series_id).toBe(a.event!.series_id);
    expect(await review({ feedItemId: "i-bath1", action: "approve" })).toMatchObject({
      ok: false,
      code: "already_reviewed",
    });
    expect(n("SELECT COUNT(*) n FROM events WHERE name='The Bath Antique Sale'")).toBe(2);
  });

  it("refuses an unmatched venue with candidates, and creates nothing", async () => {
    const before = n("SELECT COUNT(*) n FROM events");
    const r = await review({ feedItemId: "i-novenue", action: "approve" });
    expect(r).toMatchObject({ ok: false, code: "venue_unmatched" });
    if (r.ok) throw new Error("unreachable");
    expect(r.venue_candidates?.map((c) => c.id)).toContain("v-bath");
    expect(n("SELECT COUNT(*) n FROM events")).toBe(before);
    expect(one("SELECT review_state FROM promoter_feed_items WHERE id='i-novenue'")).toEqual({
      review_state: "awaiting_review",
    });
  });

  it("refuses a duplicate with a suggestion to link — then link changes no event field", async () => {
    const r = await review({ feedItemId: "i-tsg", action: "approve" });
    expect(r).toMatchObject({
      ok: false,
      code: "duplicate",
      suggest: { action: "link", event_id: "e-tsg" },
    });
    const before = one("SELECT * FROM events WHERE id='e-tsg'");
    const l = await review({ feedItemId: "i-tsg", action: "link", eventId: "e-tsg" });
    expect(l).toMatchObject({ ok: true, review_state: "linked", event: { id: "e-tsg" } });
    expect(one("SELECT * FROM events WHERE id='e-tsg'")).toEqual(before);
    expect(one("SELECT event_id FROM promoter_feed_items WHERE id='i-tsg'")).toEqual({
      event_id: "e-tsg",
    });
    expect(n("SELECT COUNT(*) n FROM admin_actions WHERE action='feed_item.link'")).toBe(1);
  });

  it("approve_as_occurrence attaches to the named series and creates no second hub", async () => {
    const hubs = n("SELECT COUNT(*) n FROM event_series");
    const r = await review({
      feedItemId: "i-flea",
      action: "approve_as_occurrence",
      seriesId: "s-dover",
    });
    expect(r).toMatchObject({ ok: true, event: { series_id: "s-dover" } });
    expect(n("SELECT COUNT(*) n FROM event_series")).toBe(hubs);
    // The occurrence keeps the name the feed gives it.
    expect(one("SELECT name FROM events WHERE series_id='s-dover'")).toEqual({
      name: "The Dover Wednesday Flea Market",
    });
    expect(
      await review({ feedItemId: "i-bath1", action: "approve_as_occurrence", seriesId: "nope" })
    ).toMatchObject({
      code: "series_not_found",
    });
  });
});

describe("reviewer answers to a refusal (venue_id, not_duplicate_of)", () => {
  it("venue_id completes an item whose feed names a venue but no town, and uses exactly that venue", async () => {
    seedItem(
      "i-notown",
      feedEvent({
        externalId: "201",
        title: "North Pole Express",
        venue: { name: "Bath Middle Sch.", address: null, city: null, state: null, zip: null },
      })
    );
    // Without an answer: the row has no town, so it cannot become a listing.
    expect(await review({ feedItemId: "i-notown", action: "approve" })).toMatchObject({
      ok: false,
      code: "invalid_item",
    });
    // A second, same-named venue in the same town: re-resolving the name would be
    // ambiguous, so the picked id must be used as-is.
    raw
      .prepare(
        "INSERT INTO venues (id, name, slug, city, state) VALUES ('v-bath2','Bath Middle School','bath-middle-school-2','Bath','ME')"
      )
      .run();
    const r = await review({ feedItemId: "i-notown", action: "approve", venueId: "v-bath2" });
    expect(r).toMatchObject({ ok: true, review_state: "linked" });
    if (!r.ok) throw new Error("unreachable");
    expect(one("SELECT venue_id, status FROM events WHERE id=?", r.event!.id)).toEqual({
      venue_id: "v-bath2",
      status: "APPROVED",
    });
    const a = one<{ payload_json: string }>(
      "SELECT payload_json FROM admin_actions WHERE action='feed_item.approve' AND target_id='i-notown'"
    );
    expect(JSON.parse(a.payload_json)).toMatchObject({ venue_id: "v-bath2", venue_picked: true });
  });

  it("an unknown venue_id is refused and creates nothing", async () => {
    const before = n("SELECT COUNT(*) n FROM events");
    expect(
      await review({ feedItemId: "i-novenue", action: "approve", venueId: "v-nope" })
    ).toMatchObject({ ok: false, code: "venue_not_found" });
    expect(n("SELECT COUNT(*) n FROM events")).toBe(before);
  });

  it("not_duplicate_of overrides only the match the reviewer named", async () => {
    // Another organizer's DIFFERENT show at the same venue a day earlier: dedup's
    // venue ±7-day stage calls it the same event.
    raw
      .prepare(
        "INSERT INTO promoters (id, company_name, slug) VALUES ('p-x','Bath Chamber','bath-chamber')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO events (id, name, slug, promoter_id, venue_id, start_date, end_date, status) VALUES ('e-xmas','Bath Spirit of Christmas Fair','bath-spirit-of-christmas-2026','p-x','v-bath',?,?,'APPROVED')"
      )
      .run(Date.UTC(2026, 11, 12, 12) / 1000, Date.UTC(2026, 11, 12, 12) / 1000);
    const xmas = one("SELECT * FROM events WHERE id='e-xmas'");

    expect(await review({ feedItemId: "i-bath1", action: "approve" })).toMatchObject({
      ok: false,
      code: "listed_by_another_organizer",
      suggest: { event_id: "e-xmas" },
    });
    // Naming a different event does not wave this match through.
    expect(
      await review({ feedItemId: "i-bath1", action: "approve", notDuplicateOf: "e-tsg" })
    ).toMatchObject({ ok: false, code: "listed_by_another_organizer" });
    expect(n("SELECT COUNT(*) n FROM events WHERE name='The Bath Antique Sale'")).toBe(0);

    const r = await review({ feedItemId: "i-bath1", action: "approve", notDuplicateOf: "e-xmas" });
    expect(r).toMatchObject({ ok: true, review_state: "linked" });
    if (!r.ok) throw new Error("unreachable");
    expect(r.event!.id).not.toBe("e-xmas");
    expect(one("SELECT promoter_id, venue_id FROM events WHERE id=?", r.event!.id)).toEqual({
      promoter_id: "p-g",
      venue_id: "v-bath",
    });
    // The other organizer's listing is untouched.
    expect(one("SELECT * FROM events WHERE id='e-xmas'")).toEqual(xmas);
    const a = one<{ payload_json: string }>(
      "SELECT payload_json FROM admin_actions WHERE action='feed_item.approve' AND target_id='i-bath1'"
    );
    expect(JSON.parse(a.payload_json)).toMatchObject({ not_duplicate_of: "e-xmas" });
  });

  it("not_duplicate_of also answers a same-organizer duplicate refusal, for that event only", async () => {
    expect(
      await review({ feedItemId: "i-tsg", action: "approve", notDuplicateOf: "e-other" })
    ).toMatchObject({ ok: false, code: "duplicate" });
    const r = await review({ feedItemId: "i-tsg", action: "approve", notDuplicateOf: "e-tsg" });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("unreachable");
    expect(r.event!.id).not.toBe("e-tsg");
  });
});

describe("reject", () => {
  it("needs a reason, records it, and a rejected item cannot be approved by accident", async () => {
    expect(await review({ feedItemId: "i-wedding", action: "reject" })).toMatchObject({
      code: "bad_request",
    });
    const r = await review({ feedItemId: "i-wedding", action: "reject", note: "private event" });
    expect(r).toMatchObject({ ok: true, review_state: "rejected" });
    expect(
      one(
        "SELECT review_state, review_note, event_id FROM promoter_feed_items WHERE id='i-wedding'"
      )
    ).toEqual({
      review_state: "rejected",
      review_note: "private event",
      event_id: null,
    });
    expect(await review({ feedItemId: "i-wedding", action: "approve" })).toMatchObject({
      code: "already_reviewed",
    });
    expect(n("SELECT COUNT(*) n FROM events WHERE name='Teele Wedding'")).toBe(0);
    expect(n("SELECT COUNT(*) n FROM admin_actions WHERE action='feed_item.reject'")).toBe(1);
  });
});

describe("list", () => {
  it("lists the queue with the closest existing event, and leaves out reviewed items", async () => {
    const before = await listFeedItems(db as never, { reviewState: "awaiting_review" });
    expect(before.map((i) => i.id).sort()).toEqual([
      "i-bath1",
      "i-bath2",
      "i-flea",
      "i-novenue",
      "i-tsg",
      "i-wedding",
    ]);
    expect(before.find((i) => i.id === "i-tsg")?.closest_event).toMatchObject({ id: "e-tsg" });
    expect(before.find((i) => i.id === "i-bath1")?.closest_event).toBeNull();
    expect(before.find((i) => i.id === "i-bath1")?.venue).toBe("Bath Middle School, Bath, ME");
    await review({ feedItemId: "i-wedding", action: "reject", note: "private event" });
    const after = await listFeedItems(db as never, { reviewState: "awaiting_review" });
    expect(after.map((i) => i.id)).not.toContain("i-wedding");
    expect(
      (await listFeedItems(db as never, { reviewState: "rejected" })).map((i) => i.id)
    ).toEqual(["i-wedding"]);
  });
});

describe("routes", () => {
  const post = (id: string, body: unknown) =>
    reviewPost(
      new Request(`https://meetmeatthefair.com/api/admin/feed-items/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ id }) } as never
    );

  it("are admin/internal only", async () => {
    authorized = false;
    expect((await post("i-wedding", { action: "reject", note: "x" })).status).toBe(401);
    expect(
      (
        await listGet(
          new Request("https://meetmeatthefair.com/api/admin/feed-items") as never,
          { params: Promise.resolve({}) } as never
        )
      ).status
    ).toBe(401);
    expect(n("SELECT COUNT(*) n FROM admin_actions")).toBe(0);
  });

  it("map refusals to status codes and return the body whole", async () => {
    expect((await post("i-tsg", { action: "bogus" })).status).toBe(400);
    const dup = await post("i-tsg", { action: "approve" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: "duplicate", suggest: { event_id: "e-tsg" } });
    expect((await post("missing", { action: "reject", note: "x" })).status).toBe(404);
    const ok = await post("i-wedding", { action: "reject", note: "private event" });
    expect(ok.status).toBe(200);
    const list = await listGet(
      new Request(
        "https://meetmeatthefair.com/api/admin/feed-items?review_state=rejected"
      ) as never,
      { params: Promise.resolve({}) } as never
    );
    expect(await list.json()).toMatchObject({
      count: 1,
      items: [{ id: "i-wedding", review_note: "private event" }],
    });
  });
});
