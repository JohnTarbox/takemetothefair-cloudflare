/**
 * OPE-1682 — a REGISTERED promoter can opt in to listing its camps and
 * workshops from its feed (John's ruling 2026-11-18: registered promoters only).
 *
 * Driven through the real tools: set_promoter_camps_workshops (the setter and
 * its refusal), ingest_promoter_feed (the reader applying it) and
 * list_promoter_feeds (the setting shown). Fixture items are OHTM-shaped: the
 * camp comes from education@, which the organizer rule drops, and its title
 * says "Camp", which the program rule drops.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const, email: "admin@test" };
const FEED_URL = "https://owlshead.example/wp-json/tribe/events/v1/events";
const T0 = new Date("2026-11-18T15:00:00Z");

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;
let feedId: string;

const item = (id: number, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  url: `https://owlshead.example/event/${id}/`,
  description: "<p>Ages 8–12. Registration required.</p>",
  start_date: "2026-12-29 09:00:00",
  end_date: "2026-12-29 15:00:00",
  all_day: false,
  timezone: "America/New_York",
  venue: { venue: "Owls Head Transportation Museum", city: "Owls Head", state: "ME" },
  organizer: [{ organizer: "Education", email: "education@ohtm.example" }],
  categories: [{ name: "Spring" }],
  cost: "",
  ...over,
});

/** The acceptance fixture plus the shapes the rule must still drop. */
const FEED = [
  item(1, "Camp: Tinker and Test Team"),
  item(2, "Owls Nest: Magnet Exploration"),
  item(3, "STEM Saturdays: Rockets"),
  item(4, "Junior Inventors"),
  item(5, "Engine Rebuild", { categories: [{ name: "Workshop" }] }),
  item(6, "[Closed] Winter Camp day"),
];

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await server.invoke(name, args)) as Result;
  return {
    isError: !!r.isError,
    text: r.content[0].text,
    body: r.isError ? null : JSON.parse(r.content[0].text),
  };
};

const register = () =>
  raw
    .prepare(
      "UPDATE promoters SET claimed=1, user_id='u-sammi', claimed_by='u-sammi' WHERE id='p1'"
    )
    .run();
const unregister = () =>
  raw.prepare("UPDATE promoters SET claimed=0, user_id=NULL, claimed_by=NULL WHERE id='p1'").run();
const setting = () =>
  (
    raw.prepare("SELECT include_camps_workshops v FROM promoters WHERE id='p1'").get() as {
      v: number;
    }
  ).v;

const ingest = async () => {
  const r = await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
  expect(r.isError, r.text).toBe(false);
  // Positive landmark: every fixture item was read, so a verdict below is a
  // verdict on that item, not on an item the reader never saw.
  expect(r.body.items_read).toBe(FEED.length);
  const byTitle = new Map<
    string,
    { included: boolean; inclusion_reason: string; review_state: string }
  >(r.body.items.map((i: { title: string }) => [i.title, i]));
  return { body: r.body, v: (t: string) => byTitle.get(t)! };
};

beforeEach(async () => {
  ({ db, raw } = createTestDb());
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ events: FEED, next_rest_url: null }), {
      status: 200,
    })) as unknown as typeof fetch;
  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')").run();
  raw
    .prepare(
      "INSERT INTO users (id, email, role) VALUES ('u-sammi','sammi@ohtm.example','PROMOTER')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p1','Owls Head Transportation Museum','ohtm','https://owlshead.example')"
    )
    .run();
  server = new CapturingMcpServer();
  registerOrganizerFeedTools(server as never, db, ADMIN, { fetchImpl: fakeFetch, now: () => T0 });
  const reg = await call("register_promoter_feed", { promoter_id: "p1", feed_url: FEED_URL });
  expect(reg.isError, reg.text).toBe(false);
  feedId = reg.body.feed_id;
});

describe("OPE-1682 — camps/workshops opt-in", () => {
  it("no opt-in: every camp, workshop and program item is dropped, as before", async () => {
    register(); // registered, but has not opted in
    const { body, v } = await ingest();
    expect(body.camps_workshops_opt_in).toEqual({
      setting: false,
      promoter_registered: true,
      active: false,
    });
    for (const f of FEED) expect(v(f.title).included, f.title).toBe(false);
    expect(v("Camp: Tinker and Test Team").inclusion_reason).toBe(
      "program title matches /\\bcamp\\b/"
    );
    expect(v("Engine Rebuild").inclusion_reason).toMatch(/program description|education@/);
  });

  it("registered + opted in: the camp and the Workshop-category item go to review; programs and closures stay dropped", async () => {
    register();
    const set = await call("set_promoter_camps_workshops", { promoter_id: "p1", enabled: true });
    expect(set.isError, set.text).toBe(false);
    expect(set.body.after).toEqual({ setting: true, promoter_registered: true, active: true });
    expect(setting()).toBe(1);

    const { body, v } = await ingest();
    expect(body.camps_workshops_opt_in.active).toBe(true);
    expect(v("Camp: Tinker and Test Team")).toMatchObject({
      included: true,
      review_state: "awaiting_review",
      inclusion_reason: "camp/workshop opt-in: title matches /\\bcamps?\\b/",
    });
    expect(v("Engine Rebuild")).toMatchObject({
      included: true,
      review_state: "awaiting_review",
      inclusion_reason: 'camp/workshop opt-in: category "Workshop"',
    });
    expect(v("Owls Nest: Magnet Exploration").included).toBe(false);
    expect(v("STEM Saturdays: Rockets").included).toBe(false);
    expect(v("Junior Inventors").included).toBe(false);
    expect(v("[Closed] Winter Camp day").inclusion_reason).toMatch(/closure/);
    expect(body.awaiting_review).toBe(2);
    // Review, never publish: no event row was created from a feed item.
    expect((raw.prepare("SELECT count(*) n FROM events").get() as { n: number }).n).toBe(0);

    const list = await call("list_promoter_feeds", { promoter_id: "p1" });
    expect(list.body.feeds[0].camps_workshops_opt_in).toEqual({
      setting: true,
      promoter_registered: true,
      active: true,
    });
    const audit = raw
      .prepare(
        "SELECT action, target_id FROM admin_actions WHERE action='promoter.camps_workshops_opt_in'"
      )
      .all();
    expect(audit).toEqual([{ action: "promoter.camps_workshops_opt_in", target_id: "p1" }]);
  });

  it("unregistered: turning it on is refused, nothing is stored, and camp items stay dropped", async () => {
    const set = await call("set_promoter_camps_workshops", { promoter_id: "p1", enabled: true });
    expect(set.isError).toBe(true);
    expect(set.text).toMatch(/not a registered promoter/);
    expect(setting()).toBe(0);
    const { body, v } = await ingest();
    expect(body.camps_workshops_opt_in).toEqual({
      setting: false,
      promoter_registered: false,
      active: false,
    });
    expect(v("Camp: Tinker and Test Team").included).toBe(false);
  });

  it("a promoter that stops being registered stops getting the exception, though the setting stays stored", async () => {
    register();
    expect(
      (await call("set_promoter_camps_workshops", { promoter_id: "p1", enabled: true })).isError
    ).toBe(false);
    unregister();
    const { body, v } = await ingest();
    expect(body.camps_workshops_opt_in).toEqual({
      setting: true,
      promoter_registered: false,
      active: false,
    });
    expect(v("Camp: Tinker and Test Team").included).toBe(false);
    // Turning it off needs no registration.
    const off = await call("set_promoter_camps_workshops", { promoter_id: "p1", enabled: false });
    expect(off.isError, off.text).toBe(false);
    expect(setting()).toBe(0);
  });

  it("an unknown promoter is refused", async () => {
    const r = await call("set_promoter_camps_workshops", { promoter_id: "nope", enabled: false });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });
});
