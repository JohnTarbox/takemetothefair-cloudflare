/**
 * OPE-1511 — get_contact_scorecard. Reproduces the 2026-10-20 acceptance state
 * (8 contacts / 3 validated; 3 asks: 1 confirmed, 1 replied, 1 no_response) and
 * pins each definition the module states: parent rows only, human sources only,
 * New York business days with holidays, all three inbound-link citation shapes,
 * and NULL — never 0 — on an empty denominator.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { supportObligations } from "../src/schema.js";
import {
  addBusinessDays,
  CONTACT_SCORECARD_QUERIES,
  computeContactScorecard,
  isBusinessDay,
} from "../src/schema.js";
import { registerContactScorecardTool } from "../src/tools/admin-contact-scorecard.js";

const NOW = new Date("2026-10-20T17:00:00Z"); // Tuesday
const S = (iso: string) => Math.floor(Date.parse(iso) / 1000);
let db: TestDb;
let raw: Database.Database;

const contact = (id: string, email: string, status: string, promoter = "pr1") =>
  raw
    .prepare(
      `INSERT INTO promoter_contacts (id, promoter_id, email, validation_method, status, created_at, updated_at)
       VALUES (?, ?, ?, 'replied_to_our_mail', ?, 0, 0)`
    )
    .run(id, promoter, email, status);
const mail = (id: string, from: string, at: string, parent: string | null = null) =>
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, parent_email_id, created_at)
       VALUES (?, ?, ?, 'hello@meetmeatthefair.com', 'correction', ?, ?)`
    )
    .run(id, S(at), from, parent, S(at));
const send = (id: string, to: string, at: string, source: string) =>
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, status) VALUES (?, ?, ?, ?, 'sent')`
    )
    .run(id, S(at), to, source);
const obligation = (id: string, inboundId: string) =>
  raw
    .prepare(
      `INSERT INTO support_obligations (id, inbound_email_id, from_address, opened_at, status) VALUES (?, ?, 'x', 0, 'open')`
    )
    .run(id, inboundId);
const ask = (id: string, status: string, sentAt: string, inbound: string | null = null) =>
  raw
    .prepare(
      `INSERT INTO promoter_outreach_attempts (id, promoter_id, to_address, subject, body_text, status, created_at, sent_at, outcome_at, inbound_email_id)
       VALUES (?, 'pr1', 'info@usathanksgiving.com', 's', 'b', ?, ?, ?, ?, ?)`
    )
    .run(id, status, S(sentAt), S(sentAt), status === "sent" ? null : S(sentAt) + 86400, inbound);
const card = (windowDays = 28) => computeContactScorecard(db, { windowDays, now: NOW });

beforeEach(() => {
  ({ db, raw } = createTestDb());
  const cfg = getTableConfig(supportObligations);
  const cols = cfg.columns.map(
    (c) =>
      `${c.name} ${c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT"}${c.primary ? " PRIMARY KEY" : ""}`
  );
  raw.exec(`CREATE TABLE IF NOT EXISTS ${cfg.name} (${cols.join(", ")});`);
  raw.prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('pr1', 'USA', 'usa')`).run();
});

describe("business days (America/New_York, weekends + federal holidays)", () => {
  it("Friday mail is due Monday", () => {
    expect(addBusinessDays(new Date("2026-10-16T19:00:00Z"), 1).toISOString()).toBe(
      "2026-10-19T19:00:00.000Z"
    );
  });
  it("Columbus Day (Mon 2026-10-12) is skipped", () => {
    expect(isBusinessDay(new Date("2026-10-12T15:00:00Z"))).toBe(false);
    expect(addBusinessDays(new Date("2026-10-09T19:00:00Z"), 1).toISOString()).toBe(
      "2026-10-13T19:00:00.000Z"
    );
  });
  it("the day boundary is New York's, not UTC's: Sat 02:00Z is still Friday in NY", () => {
    expect(isBusinessDay(new Date("2026-10-17T02:00:00Z"))).toBe(true);
  });
});

describe("OPE-1511 — the 2026-10-20 acceptance state", () => {
  beforeEach(() => {
    for (let i = 1; i <= 5; i++) contact(`c${i}`, `candidate${i}@usathanksgiving.com`, "candidate");
    for (let i = 1; i <= 3; i++) contact(`v${i}`, `validated${i}@usathanksgiving.com`, "validated");
    ask("a-confirmed", "confirmed", "2026-10-13T12:00:00Z");
    ask("a-replied", "replied", "2026-10-20T12:00:00Z");
    ask("a-noresp", "no_response", "2026-10-06T12:00:00Z");
  });

  it("8 contacts / 3 validated; 3 asks, 2 replied (cumulative), reply rate 2/3", async () => {
    const c = await card();
    expect(c.coverage).toMatchObject({
      contactsByStatus: { candidate: 5, validated: 3 },
      contactsTotal: 8,
    });
    expect(c.current.theirResponsiveness).toMatchObject({
      asksSent: 3,
      replied: 2,
      replyRate: 0.667,
    });
  });

  it("the MCP tool returns the same card", async () => {
    const server = new CapturingMcpServer();
    registerContactScorecardTool(server as never, db, { userId: "u", role: "ADMIN" } as never);
    const res = (await server.invoke("get_contact_scorecard", {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text).coverage.contactsTotal).toBe(8);
  });
});

describe("OPE-1511 — our responsiveness", () => {
  beforeEach(() => contact("v1", "debra@usathanksgiving.com", "validated"));

  it("counts a parent email once (children are not separate emails); a manual reply within 1 business day", async () => {
    mail("p1", "Debra@USAthanksgiving.com ", "2026-10-16T19:00:00Z");
    mail("p1-child", "debra@usathanksgiving.com", "2026-10-16T19:00:00Z", "p1");
    send("r1", "debra@usathanksgiving.com", "2026-10-19T15:00:00Z", "reply:manual");
    obligation("o1", "p1-child"); // an obligation on a CHILD covers the parent
    const r = (await card()).current;
    expect(r.ourResponsiveness).toMatchObject({
      contactEmails: 1,
      medianHoursToHumanReply: 68,
      pctWithin1BusinessDay: 1,
      // Fri 19:00Z + 2 business days = Tue 19:00Z, after NOW (Tue 17:00Z): not
      // yet due, so the 2-day denominator is empty — NULL, not 0.
      pctNoReplyAfter2BusinessDays: null,
    });
    expect(r.leakage.contactEmailsWithoutObligation).toEqual([]);
  });

  it("an automatic ack is not a human reply; an unanswered email past 2 business days is listed, and leaks without an obligation", async () => {
    mail("p2", "debra@usathanksgiving.com", "2026-10-13T14:00:00Z");
    send("ack", "debra@usathanksgiving.com", "2026-10-13T14:00:05Z", "reply:correction-ack");
    const r = (await card()).current;
    expect(r.ourResponsiveness).toMatchObject({
      contactEmails: 1,
      medianHoursToHumanReply: null,
      pctWithin1BusinessDay: 0,
      noReplyAfter2BusinessDaysIds: ["p2"],
    });
    expect(r.leakage.contactEmailsWithoutObligation).toEqual(["p2"]);
  });

  it("an approved operator draft (operator:outbound) counts as a human reply", async () => {
    mail("p3", "debra@usathanksgiving.com", "2026-10-14T14:00:00Z");
    send("d1", "debra@usathanksgiving.com", "2026-10-14T16:00:00Z", "operator:outbound");
    expect((await card()).current.ourResponsiveness.medianHoursToHumanReply).toBe(2);
  });

  it("a rejected contact's mail is not contact mail", async () => {
    contact("x", "spam@usathanksgiving.com", "rejected");
    mail("p4", "spam@usathanksgiving.com", "2026-10-14T14:00:00Z");
    expect((await card()).current.ourResponsiveness.contactEmails).toBe(0);
  });

  it("mail older than the window falls in `prior`, not `current`", async () => {
    mail("old", "debra@usathanksgiving.com", "2026-09-10T14:00:00Z");
    const c = await card();
    expect(c.current.ourResponsiveness.contactEmails).toBe(0);
    expect(c.prior.ourResponsiveness.contactEmails).toBe(1);
  });

  it("rates are NULL — never 0 — on an empty denominator", async () => {
    const c = await card();
    expect(c.current.ourResponsiveness.pctWithin1BusinessDay).toBeNull();
    expect(c.current.theirResponsiveness.replyRate).toBeNull();
    expect(c.coverage.pctUpcomingWithValidatedContact).toBeNull();
    expect(c.allTime.accuracy.contact.supersededRate).toBeNull();
  });
});

describe("OPE-1511 — accuracy: all three inbound-link citation shapes are contact citations", () => {
  it("counts /admin/inbound/<id>, ?id=<id> and #<id>, and compares with website citations", async () => {
    contact("v1", "debra@usathanksgiving.com", "validated");
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    for (const id of ids) mail(id, "debra@usathanksgiving.com", "2026-10-14T14:00:00Z");
    raw
      .prepare(
        `INSERT INTO events (id, name, slug, promoter_id, status) VALUES ('e1','E','e','pr1','APPROVED')`
      )
      .run();
    const cite = (id: string, url: string, type: string, state = "active") =>
      raw
        .prepare(
          `INSERT INTO event_data_citations (id, event_id, field_name, value, source_url, source_type, state, created_at, updated_at)
           VALUES (?, 'e1', 'start_date', 'v', ?, ?, ?, 0, 0)`
        )
        .run(id, url, type, state);
    cite(
      "c1",
      `https://meetmeatthefair.com/admin/inbound/${ids[0]}`,
      "user_submitted",
      "superseded"
    );
    cite("c2", `https://meetmeatthefair.com/admin/inbound-emails?id=${ids[1]}`, "other");
    cite("c3", `https://meetmeatthefair.com/admin/inbound-emails#${ids[2]}`, "user_submitted");
    cite("w1", "https://usathanksgiving.com/", "official_website");
    raw
      .prepare(
        `INSERT INTO event_discrepancies (id, event_id, field_class, divergent_source_url, detected_by, detected_at)
         VALUES ('d1', 'e1', 'dates', 'https://usathanksgiving.com/', 'test', 0)`
      )
      .run();
    const a = (await card()).allTime.accuracy;
    expect(a.contact).toMatchObject({ total: 3, superseded: 1, flagged: 0, supersededRate: 0.333 });
    expect(a.website).toMatchObject({ total: 1, superseded: 0, flagged: 1, flaggedRate: 1 });
  });
});

// OPE-1663 — the per-inbound "first human reply" probe on `lower(l.recipient)`
// scanned the whole ledger every time (33,070 rows for 10 inbound rows on prod,
// 2026-11-17). The fix is an expression index, loaded here from the migration
// itself so the suite tests the SQL prod runs.
const LOWER_RECIPIENT_INDEX = "idx_email_send_ledger_lower_recipient_sent_at";
const INDEX_SQL = readFileSync(
  join(__dirname, "../../drizzle/0427_ope1663_ledger_lower_recipient.sql"),
  "utf8"
);

describe("OPE-1663 — the recipient lookups use the lower(recipient) expression index", () => {
  const plan = (name: keyof typeof CONTACT_SCORECARD_QUERIES): string[] =>
    (
      raw
        .prepare(
          `EXPLAIN QUERY PLAN ${CONTACT_SCORECARD_QUERIES[name].replace(/:from|:to|:now/g, "0")}`
        )
        .all() as Array<{ detail: string }>
    ).map((r) => r.detail);
  const ledgerLines = (lines: string[]) => lines.filter((d) => /\b(SCAN|SEARCH) l\b/.test(d));

  // The shared harness creates email_send_ledger with NO indexes; prod has these
  // (drizzle/0308). Without them the planner's alternatives are not prod's, and
  // the control would measure a choice prod never makes. Prod's plan before
  // 0427 (EXPLAIN QUERY PLAN, 2026-11-17): `SEARCH l USING INDEX
  // idx_email_send_ledger_status (status=?)` — nearly every row is 'sent', so
  // that is a full read of the ledger per inbound email.
  beforeEach(() => {
    raw["exec"](`
      CREATE INDEX idx_email_send_ledger_recipient ON email_send_ledger(recipient);
      CREATE INDEX idx_email_send_ledger_sent_at ON email_send_ledger(sent_at);
      CREATE INDEX idx_email_send_ledger_status ON email_send_ledger(status);
    `);
  });

  it("migration 0427 creates the index (precondition for every assertion below)", () => {
    raw["exec"](INDEX_SQL);
    const idx = raw
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(LOWER_RECIPIENT_INDEX) as { sql: string } | undefined;
    expect(idx?.sql).toMatch(/lower\(recipient\), sent_at/);
  });

  for (const name of ["contact_emails", "validated_silent_12mo"] as const) {
    it(`${name}: without the index the ledger probe cannot seek on lower(recipient) (the control)`, () => {
      const all = plan(name);
      const lines = ledgerLines(all);
      expect(lines.length, all.join(" | ")).toBe(1); // positive landmark: the probe line was found
      expect(lines[0], all.join(" | ")).not.toContain(LOWER_RECIPIENT_INDEX);
      expect(lines[0], all.join(" | ")).not.toMatch(/lower\(recipient\)|<expr>=/);
    });

    it(`${name}: with the index the ledger probe SEARCHes it on lower(recipient)`, () => {
      raw["exec"](INDEX_SQL);
      const all = plan(name);
      const lines = ledgerLines(all);
      expect(lines.length, all.join(" | ")).toBe(1);
      expect(lines[0], all.join(" | ")).toContain(`SEARCH l USING INDEX ${LOWER_RECIPIENT_INDEX}`);
    });
  }

  it("parity: the card is identical with and without the index on mixed-case data", async () => {
    contact("v1", "debra@usathanksgiving.com", "validated");
    contact("v2", "info@garlicfest.example", "validated");
    mail("m1", "debra@usathanksgiving.com", "2026-10-13T14:00:00Z");
    mail("m2", " DEBRA@usathanksgiving.com", "2026-10-16T19:00:00Z");
    mail("m3", "info@garlicfest.example", "2026-09-10T12:00:00Z"); // prior window
    mail("m4", "info@garlicfest.example", "2026-10-19T12:00:00Z"); // unanswered
    // Noise rows: other recipients, wrong sources, a failed send, a reply BEFORE the mail.
    for (let i = 0; i < 40; i++)
      send(`n${i}`, `other${i}@example.com`, "2026-10-14T12:00:00Z", "reply:manual");
    send("early", "debra@usathanksgiving.com", "2026-10-12T10:00:00Z", "reply:manual");
    send("ack", "DEBRA@usathanksgiving.com", "2026-10-13T14:00:05Z", "reply:correction-ack");
    send("r1", "DEBRA@USATHANKSGIVING.COM", "2026-10-14T09:00:00Z", "reply:manual");
    send("r2", "debra@usathanksgiving.com", "2026-10-19T15:00:00Z", "operator:outbound");
    send("r3", "Info@Garlicfest.example", "2026-09-11T12:00:00Z", "reply:manual-gmail-paste");
    raw
      .prepare(
        `INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, status) VALUES ('f1', ?, 'info@garlicfest.example', 'reply:manual', 'failed')`
      )
      .run(S("2026-10-19T13:00:00Z"));

    const before = await card();
    raw["exec"](INDEX_SQL);
    expect(ledgerLines(plan("contact_emails"))[0]).toContain(LOWER_RECIPIENT_INDEX);
    const after = await card();

    // Landmarks: the sample exercises a reply, a non-reply and both windows.
    expect(before.current.ourResponsiveness.contactEmails).toBe(3);
    expect(before.prior.ourResponsiveness.contactEmails).toBe(1);
    expect(before.current.ourResponsiveness.medianHoursToHumanReply).not.toBeNull();
    expect(before.current.ourResponsiveness.noReplyAfter2BusinessDaysIds).toEqual([]);
    expect(after).toEqual(before);
  });
});
