/**
 * OPE-1613 — organizer feed ingestion with field-level provenance and pins.
 *
 * The acceptance-2 replay runs end to end through the MCP tools against a
 * mocked TEC REST feed, on the real 0406 DDL (loaded from the migration file
 * by setup-db). No network, no mail: the only fetch is the mocked feed, and
 * the test asserts nothing reached email_send_ledger.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";
import { mapTecEvent } from "../src/feeds/tec.js";
import { decideInclusion, DEFAULT_INCLUSION_RULES } from "../src/feeds/inclusion.js";
import { detectSelfContradictions } from "../src/feeds/ingest.js";
import { evaluatePin, normalizeAnswer } from "../src/feeds/provenance.js";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const T0 = new Date("2026-11-10T18:00:00Z");
const FEED_URL = "https://owlshead.example/wp-json/tribe/events/v1/events";

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;
let clock: Date;
let feedPayload: Record<string, unknown>[];
let fetchCalls: string[];

/** An OHTM-shaped TEC item. */
const tecItem = (over: Record<string, unknown> = {}) => ({
  id: 9101,
  title: "Junior Inventors",
  url: "https://owlshead.example/event/junior-inventors/",
  description: "<p>Join us at 4:30 PM for an afternoon of building.</p>",
  start_date: "2027-03-19 04:30:00",
  end_date: "2027-03-19 06:00:00",
  all_day: false,
  timezone: "America/New_York",
  venue: { venue: "Owls Head Transportation Museum", city: "Owls Head", state: "ME" },
  organizer: [{ organizer: "Events", email: "events@ohtm.example" }],
  categories: [{ name: "Spring" }],
  cost: "",
  ...over,
});

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await server.invoke(name, args)) as Result;
  return {
    isError: !!r.isError,
    text: r.content[0].text,
    body: r.isError ? null : JSON.parse(r.content[0].text),
  };
};
const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  raw.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  raw.prepare(sql).get(...p) as T;
const openTime = () =>
  one<{ open_time: string }>("SELECT open_time FROM event_days WHERE event_id='e1'").open_time;
const openFeedRows = () =>
  q<{ id: string; divergent_value: string; notes: string }>(
    "SELECT id, divergent_value, notes FROM event_discrepancies WHERE detected_by='organizer_feed' AND resolution_status='open'"
  );

let feedId: string;

beforeEach(async () => {
  ({ db, raw } = createTestDb());
  clock = T0;
  fetchCalls = [];
  feedPayload = [tecItem()];
  const fakeFetch = (async (url: RequestInfo | URL) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ events: feedPayload, next_rest_url: null }), {
      status: 200,
    });
  }) as typeof fetch;
  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')").run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p1','Owls Head Transportation Museum','ohtm','https://owlshead.example')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO venues (id, name, slug, city, state) VALUES ('v1','Owls Head Transportation Museum','ohtm-venue','Owls Head','ME')"
    )
    .run();
  // The event we hold carries the feed's bad 04:30 (an earlier import took it as-is).
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, venue_id, start_date, end_date, status, source_url) VALUES ('e1','Junior Inventors','junior-inventors','p1','v1',?,?, 'APPROVED', 'https://owlshead.example/event/junior-inventors/')"
    )
    .run(Date.UTC(2027, 2, 19, 12) / 1000, Date.UTC(2027, 2, 19, 12) / 1000);
  raw
    .prepare(
      "INSERT INTO event_days (id, event_id, date, open_time, close_time) VALUES ('d1','e1','2027-03-19','04:30','06:00')"
    )
    .run();
  const ts = Math.floor(T0.getTime() / 1000);
  raw
    .prepare(
      "INSERT INTO promoter_contacts (id, promoter_id, name, email, validation_method, status, first_validated_at, last_heard_at, created_at, updated_at) VALUES ('c1','p1','Sammi Example','events@ohtm.example','domain_verified','validated',?,?,?,?)"
    )
    .run(ts, ts, ts, ts);
  const mail = raw.prepare(
    "INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, sender_auth, created_at) VALUES (?,?,?,?,?,?,?)"
  );
  mail.run(
    "in-ok",
    ts,
    "Sammi <events@ohtm.example>",
    "submit@meetmeatthefair.com",
    "support",
    "pass",
    ts
  );
  mail.run(
    "in-stranger",
    ts,
    "someone@gmail.com",
    "submit@meetmeatthefair.com",
    "support",
    "pass",
    ts
  );
  mail.run(
    "in-nodmarc",
    ts,
    "events@ohtm.example",
    "submit@meetmeatthefair.com",
    "support",
    "partial",
    ts
  );
  server = new CapturingMcpServer();
  registerOrganizerFeedTools(server as never, db, ADMIN, {
    fetchImpl: fakeFetch,
    now: () => clock,
  });
  const reg = await call("register_promoter_feed", { promoter_id: "p1", feed_url: FEED_URL });
  expect(reg.isError).toBe(false);
  feedId = reg.body.feed_id;
});

describe("TEC mapping and the inclusion filter", () => {
  it("keeps local wall time as written — no Date round-trip", () => {
    const ev = mapTecEvent(tecItem())!;
    expect(ev.startDate).toBe("2027-03-19");
    expect(ev.startTime).toBe("04:30");
    expect(ev.organizerEmails).toEqual(["events@ohtm.example"]);
    expect(ev.description).toContain("4:30 PM");
  });

  it("drops closures and children's programs, keeps signature multi-day events", () => {
    const r = DEFAULT_INCLUSION_RULES;
    const v = (o: Record<string, unknown>) => decideInclusion(mapTecEvent(tecItem(o))!, r);
    expect(v({ title: "[Closed] Museum" }).included).toBe(false);
    expect(v({ title: "[Closed] Truck Show day" }).included).toBe(false); // closure beats "show"
    expect(v({ title: "Kids STEM Saturday", description: "" }).included).toBe(false);
    expect(v({ title: "Junior Inventors" }).reason).toMatch(/junior/);
    expect(
      v({
        title: "Wings & Wheels Airshow",
        start_date: "2027-07-17 09:00:00",
        end_date: "2027-07-18 16:00:00",
        description: "",
      }).included
    ).toBe(true);
    expect(
      v({
        title: "Lecture series",
        description: "",
        organizer: [{ email: "education@ohtm.example" }],
      }).reason
    ).toMatch(/education@/);
  });

  it("finds the three self-contradiction shapes, and names the evidence", () => {
    const ampm = detectSelfContradictions(mapTecEvent(tecItem())!);
    expect(ampm.map((f) => [f.field, f.kind, f.hint])).toEqual([
      ["start_time", "am_pm_slip", "16:30"],
    ]);
    expect(ampm[0].question).toBe(
      "Junior Inventors, 2027-03-19: your feed says 4:30 AM, the description says 4:30 PM. Which is right?"
    );
    const stateOnly = detectSelfContradictions(
      mapTecEvent(tecItem({ venue: { state: "ME" }, description: "" }))!
    );
    expect(stateOnly.map((f) => f.kind)).toEqual(["state_only_location"]);
    const cancelled = detectSelfContradictions(
      mapTecEvent(tecItem({ description: "<p>This event has been CANCELLED.</p>" }))!
    );
    expect(cancelled.map((f) => f.kind)).toEqual(["cancelled_in_text"]);
    // A morning time with no PM in its own text is not a slip.
    expect(
      detectSelfContradictions(mapTecEvent(tecItem({ description: "Doors at 6:00." }))!)
    ).toEqual([]);
  });

  it("normalizes contact answers and evaluates pins by the three-row table", () => {
    expect(normalizeAnswer("start_time", "4:30 PM")).toBe("16:30");
    expect(normalizeAnswer("start_time", "4:30pm")).toBe("16:30");
    expect(normalizeAnswer("start_time", "12 a.m.")).toBe("00:00");
    expect(normalizeAnswer("start_time", "half past four")).toBeNull();
    const pin = { pinnedValue: "16:30", feedValueAtPin: "04:30" };
    expect(evaluatePin("start_time", pin, "04:30")).toBe("same_wrong");
    expect(evaluatePin("start_time", pin, "16:30")).toBe("fixed");
    expect(evaluatePin("start_time", pin, "17:00")).toBe("third_value");
  });
});

describe("acceptance 2 — the replay", () => {
  it("04:30 → discrepancy + batched draft → validated reply pins 16:30 → feed can't overwrite → fix releases → 17:00 asks again", async () => {
    // 1. Ingest: a discrepancy opens; nothing on the event moves.
    const r1 = await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    expect(r1.isError).toBe(false);
    expect(r1.body.discrepancies_opened).toBe(1);
    expect(r1.body.items[0]).toMatchObject({ link_basis: "source_url", published: true });
    expect(openTime()).toBe("04:30");
    const [d1] = openFeedRows();
    expect(JSON.parse(d1.notes)).toMatchObject({
      field: "start_time",
      kind: "am_pm_slip",
      hint: "16:30",
    });
    expect(one("SELECT outreach_suppressed FROM event_discrepancies WHERE id=?", d1.id)).toEqual({
      outreach_suppressed: 1,
    });

    // 2. A batched draft for the validated contact, pending John's approval.
    const b1 = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    expect(b1.body).toMatchObject({ composed: true, to: "events@ohtm.example", questions: 1 });
    expect(b1.body.body).toContain(
      "your feed says 4:30 AM, the description says 4:30 PM. Which is right?"
    );
    expect(b1.body.body).toContain("For your web person:");
    expect(
      one("SELECT status, composed_by FROM operator_outbound_drafts WHERE id=?", b1.body.draft_id)
    ).toEqual({
      status: "pending",
      composed_by: "developer-claude-code:feed-discrepancy",
    });

    // 3. The validated contact answers "4:30 PM": written, cited, pinned.
    const a = await call("record_feed_discrepancy_answer", {
      discrepancy_id: d1.id,
      answer: "4:30 PM",
      inbound_email_id: "in-ok",
    });
    expect(a.body).toMatchObject({
      outcome: "pinned",
      field: "start_time",
      value: "16:30",
      applied: true,
    });
    expect(openTime()).toBe("16:30");
    const prov = await call("get_event_field_provenance", { event_id: "e1" });
    const st = prov.body.fields.find((f: { field: string }) => f.field === "start_time");
    expect(st).toMatchObject({
      current_value: "16:30",
      provenance: "validated_contact",
      pin: { pinned_value: "16:30", feed_value_at_pin: "04:30" },
    });
    expect(st.citation.source_name).toMatch(
      /^confirmed by events@ohtm\.example, validated 2026-11-10, inbound in-ok$/
    );
    expect(
      one(
        "SELECT resolution_status, resolution_source, resolved_value FROM event_discrepancies WHERE id=?",
        d1.id
      )
    ).toEqual({
      resolution_status: "resolved_divergent",
      resolution_source: "promoter_reply",
      resolved_value: "16:30",
    });

    // 4. Re-ingest the UNCHANGED feed: 16:30 survives, nothing is asked again.
    clock = new Date(T0.getTime() + 3600_000);
    const r2 = await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    expect(r2.body).toMatchObject({ pins_kept: 1, discrepancies_opened: 0 });
    expect(openTime()).toBe("16:30");
    expect(openFeedRows()).toHaveLength(0);

    // 5. The feed is fixed to 16:30: the pin releases.
    feedPayload = [tecItem({ start_date: "2027-03-19 16:30:00" })];
    const r3 = await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    expect(r3.body.pins_released).toBe(1);
    expect(one("SELECT status, release_reason FROM event_field_pins")).toEqual({
      status: "released",
      release_reason: "feed_fixed",
    });
    expect(openFeedRows()).toHaveLength(0);

    // 6. Then the feed says 17:00: a NEW discrepancy, our 16:30 stays.
    feedPayload = [
      tecItem({ start_date: "2027-03-19 17:00:00", description: "<p>Building afternoon.</p>" }),
    ];
    const r4 = await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    expect(r4.body.discrepancies_opened).toBe(1);
    expect(openTime()).toBe("16:30");
    const [d2] = openFeedRows();
    expect(d2.divergent_value).toBe("17:00");
    expect(JSON.parse(d2.notes).kind).toBe("feed_differs");

    // Nothing was sent at any point.
    expect(one("SELECT count(*) AS n FROM email_send_ledger")).toEqual({ n: 0 });
    expect(fetchCalls.every((u) => u.startsWith(FEED_URL))).toBe(true);
  });

  it("a third value while PINNED keeps the pin and asks again", async () => {
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const [d1] = openFeedRows();
    await call("record_feed_discrepancy_answer", {
      discrepancy_id: d1.id,
      answer: "4:30 PM",
      inbound_email_id: "in-ok",
    });
    feedPayload = [tecItem({ start_date: "2027-03-19 17:00:00", description: "" })];
    const r = await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    expect(r.body).toMatchObject({ third_values: 1, discrepancies_opened: 1, pins_released: 0 });
    expect(openTime()).toBe("16:30");
    expect(one("SELECT status FROM event_field_pins")).toEqual({ status: "active" });
    const [d2] = openFeedRows();
    expect(JSON.parse(d2.notes)).toMatchObject({ kind: "third_value" });
    expect(JSON.parse(d2.notes).question).toContain(
      "you told us the start time is 4:30 PM, and your feed now says 5:00 PM"
    );
  });

  it("a dry run reports the same finding and writes nothing", async () => {
    const r = await call("ingest_promoter_feed", { feed_id: feedId });
    expect(r.body).toMatchObject({ dry_run: true, discrepancies_opened: 1 });
    expect(openFeedRows()).toHaveLength(0);
    expect(q("SELECT * FROM promoter_feed_items")).toHaveLength(0);
    expect(q("SELECT * FROM admin_actions WHERE action='feed.ingested'")).toHaveLength(0);
  });

  it("an unpublished event raises no discrepancy", async () => {
    raw.prepare("UPDATE events SET status='PENDING' WHERE id='e1'").run();
    const r = await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    expect(r.body.discrepancies_opened).toBe(0);
    expect(r.body.items[0].published).toBe(false);
  });

  it("a new, included, unlinked feed event waits for review and is not created", async () => {
    feedPayload = [
      tecItem({
        id: 77,
        title: "Pine Tree Jamboree",
        url: "https://owlshead.example/event/jamboree/",
        start_date: "2027-09-10 09:00:00",
        end_date: "2027-09-13 17:00:00",
        description: "",
      }),
    ];
    const r = await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    expect(r.body).toMatchObject({ awaiting_review: 1, linked: 0 });
    expect(one("SELECT count(*) AS n FROM events")).toEqual({ n: 1 });
    expect(one("SELECT review_state FROM promoter_feed_items WHERE external_id='77'")).toEqual({
      review_state: "awaiting_review",
    });
  });
});

describe("acceptance 3 — only a validated contact pins", () => {
  it.each([
    ["in-stranger", /not a validated contact/],
    ["in-nodmarc", /sender_auth is partial/],
  ])("%s is staged, nothing written", async (inbound, reason) => {
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const [d1] = openFeedRows();
    const a = await call("record_feed_discrepancy_answer", {
      discrepancy_id: d1.id,
      answer: "4:30 PM",
      inbound_email_id: inbound,
    });
    expect(a.body.outcome).toBe("staged");
    expect(a.body.reason).toMatch(reason);
    expect(openTime()).toBe("04:30");
    expect(q("SELECT * FROM event_field_pins")).toHaveLength(0);
    expect(openFeedRows()).toHaveLength(1);
    expect(JSON.parse(openFeedRows()[0].notes).staged_answers).toHaveLength(1);
    expect(q("SELECT * FROM admin_actions WHERE action='feed.answer_staged'")).toHaveLength(1);
  });
});

describe("acceptance 4 — the weekly per-contact limit, independent of the outreach cap", () => {
  it("refuses a second batch inside 7 days, allows it after, and ignores a full outreach week", async () => {
    // A full pre-season outreach week for this promoter does not block the feed batch.
    const ins = raw.prepare(
      "INSERT INTO promoter_outreach_attempts (id, promoter_id, to_address, subject, body_text, status, created_at) VALUES (?, 'p1', 'events@ohtm.example', 's', 'b', 'sent', ?)"
    );
    for (let i = 0; i < 5; i++) ins.run(`oa${i}`, Math.floor(T0.getTime() / 1000));
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const b1 = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    expect(b1.body.composed).toBe(true);
    // A new discrepancy appears, but the contact was asked under a week ago.
    feedPayload = [tecItem({ venue: { state: "ME" } })];
    clock = new Date(T0.getTime() + 2 * 86_400_000);
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const b2 = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    expect(b2.body).toMatchObject({ composed: false, next_allowed_at: "2026-11-17T18:00:00.000Z" });
    expect(b2.body.reason).toMatch(/one batch per 7 days/);
    clock = new Date(T0.getTime() + 7 * 86_400_000);
    const b3 = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    expect(b3.body).toMatchObject({ composed: true, questions: 1 }); // the old question is not re-asked
    expect(one("SELECT count(*) AS n FROM promoter_outreach_attempts")).toEqual({ n: 5 });
  });

  it("the interval is configurable per feed", async () => {
    await call("register_promoter_feed", {
      promoter_id: "p1",
      feed_url: FEED_URL,
      batch_min_interval_days: 14,
    });
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    feedPayload = [tecItem({ venue: { state: "ME" } })];
    clock = new Date(T0.getTime() + 8 * 86_400_000);
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const b2 = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    expect(b2.body.reason).toMatch(/one batch per 14 days/);
  });

  it("repeats 'your feed still says X' at most once", async () => {
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const [d1] = openFeedRows();
    await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    await call("record_feed_discrepancy_answer", {
      discrepancy_id: d1.id,
      answer: "4:30 PM",
      inbound_email_id: "in-ok",
    });
    clock = new Date(T0.getTime() + 8 * 86_400_000);
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const b2 = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    expect(b2.body).toMatchObject({ composed: true, questions: 0, still_wrong_notes: 1 });
    expect(b2.body.body).toContain("Your calendar still shows 04:30");
    clock = new Date(T0.getTime() + 16 * 86_400_000);
    const b3 = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    expect(b3.body).toEqual({ composed: false, reason: "nothing to ask" });
  });
});

describe("acceptance 5 — nothing sends; dry-run defaults", () => {
  it("compose defaults to a dry run that writes no draft", async () => {
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const b = await call("compose_feed_discrepancy_batch", { promoter_id: "p1" });
    expect(b.body).toMatchObject({ composed: true, dry_run: true, draft_id: null });
    expect(q("SELECT * FROM operator_outbound_drafts")).toHaveLength(0);
    expect(q("SELECT * FROM feed_discrepancy_batches")).toHaveLength(0);
  });

  it("no validated contact → no batch, the question stays open", async () => {
    raw.prepare("UPDATE promoter_contacts SET status='candidate'").run();
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const b = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    expect(b.body.composed).toBe(false);
    expect(b.body.reason).toMatch(/no validated contact/);
    expect(openFeedRows()).toHaveLength(1);
  });
});

describe("provenance read — acceptance 1 (MCP half)", () => {
  it("a pre-0406 citation reads as unclassified, never inferred from source_type", async () => {
    raw
      .prepare(
        "INSERT INTO event_data_citations (id, event_id, field_name, value, source_url, source_type, state, created_at, updated_at) VALUES ('ct-old','e1','estimated_attendance','5000','https://owlshead.example','official_website','active',1,1)"
      )
      .run();
    const r = await call("get_event_field_provenance", { event_id: "e1" });
    const att = r.body.fields.find((f: { field: string }) => f.field === "estimated_attendance");
    expect(att).toMatchObject({ provenance: "unclassified", current_value: "5000" });
    const st = r.body.fields.find((f: { field: string }) => f.field === "start_time");
    expect(st).toMatchObject({ provenance: "none", current_value: "04:30", pin: null });
  });
});

describe("metrics (OPE-1511 inputs)", () => {
  it("counts raised, asked-in-a-sent-batch, answered, pins and releases", async () => {
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const [d1] = openFeedRows();
    const b = await call("compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run: false });
    raw
      .prepare("UPDATE operator_outbound_drafts SET status='sent' WHERE id=?")
      .run(b.body.draft_id);
    clock = new Date(T0.getTime() + 5 * 3600_000);
    await call("record_feed_discrepancy_answer", {
      discrepancy_id: d1.id,
      answer: "4:30 PM",
      inbound_email_id: "in-ok",
    });
    feedPayload = [tecItem({ start_date: "2027-03-19 16:30:00" })];
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const m = await call("get_feed_discrepancy_metrics", { promoter_id: "p1" });
    expect(m.body).toMatchObject({
      discrepancies_raised: 1,
      questions_sent: 1,
      questions_answered: 1,
      answer_rate: 1,
      median_hours_to_answer: 5,
      pins_created: 1,
      pins_released_feed_fixed: 1,
      third_value_changes: 0,
      batches_composed: 1,
      batches_sent: 1,
    });
  });
});

describe("guards", () => {
  it("registers nothing for a non-admin", () => {
    const s = new CapturingMcpServer();
    registerOrganizerFeedTools(s as never, db, { userId: "u2", role: "USER" as never });
    expect(s.handlers.size).toBe(0);
  });

  it("refuses an ical feed and bad inclusion JSON", async () => {
    expect(
      (
        await call("register_promoter_feed", {
          promoter_id: "p1",
          feed_url: "https://x.example/?ical=1",
          kind: "ical",
        })
      ).text
    ).toMatch(/OPE-1617/);
    expect(
      (
        await call("register_promoter_feed", {
          promoter_id: "p1",
          feed_url: "https://x.example/",
          inclusion_rules: "{nope",
        })
      ).text
    ).toMatch(/not valid JSON/);
  });

  it("refuses an answer to an already-resolved discrepancy", async () => {
    await call("ingest_promoter_feed", { feed_id: feedId, dry_run: false });
    const [d1] = openFeedRows();
    await call("record_feed_discrepancy_answer", {
      discrepancy_id: d1.id,
      answer: "4:30 PM",
      inbound_email_id: "in-ok",
    });
    const again = await call("record_feed_discrepancy_answer", {
      discrepancy_id: d1.id,
      answer: "5 PM",
      inbound_email_id: "in-ok",
    });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already resolved_divergent/);
    expect(q("SELECT * FROM event_field_pins WHERE status='active'")).toHaveLength(1);
  });
});
