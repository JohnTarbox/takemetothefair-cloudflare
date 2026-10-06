/**
 * OPE-1330 — inbound capture of promoter contacts, against a real database.
 *
 * The two specimens are the real rows (auth values copied from prod D1,
 * 2026-10-06):
 *   e188a9f7 — contact@garlicfestct.com, own domain, NO DMARC record,
 *              Yahoo-signed (dkim d=yahoo.com) → sender_auth partial.
 *   ae679c84 — christmasprelude@gmail.com, DMARC pass on gmail.com.
 * Both must land `candidate`; domain verification (a)–(f) each get a test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, type TestDb } from "./setup-db.js";
import { capturePromoterContacts } from "../src/inbound/promoter-contact-capture.js";

let db: TestDb;
let raw: Database.Database;
const T0 = Math.floor(Date.UTC(2026, 9, 6, 3, 18) / 1000);

const GARLIC_RAW =
  "mx.cloudflare.net; dkim=pass header.d=yahoo.com header.s=s2048 header.b=HKZkOXfi; dmarc=none header.from=garlicfestct.com policy.dmarc=none; spf=none smtp.mailfrom=contact@garlicfestct.com";
const PRELUDE_RAW =
  "mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20251104; dmarc=pass header.from=gmail.com policy.dmarc=none; spf=pass smtp.mailfrom=christmasprelude@gmail.com";
const passRaw = (domain: string) =>
  `mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain} policy.dmarc=reject; spf=pass smtp.mailfrom=x@${domain}`;

function promoter(
  id: string,
  website: string | null,
  contactEmail: string | null,
  userId: string | null = null
) {
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website, contact_email, user_id) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, `Promoter ${id}`, `promoter-${id}`, website, contactEmail, userId);
}

function inbound(
  id: string,
  o: {
    from: string;
    dmarc?: string | null;
    senderAuth?: string | null;
    raw?: string | null;
    orig?: string | null;
    inReplyTo?: string | null;
    refs?: string | null;
    display?: string | null;
    at?: number;
  }
) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at,
         dmarc_result, sender_auth, auth_results_raw, original_sender_auth, in_reply_to, email_references, from_display_name)
       VALUES (?, ?, ?, 'submit@meetmeatthefair.com', 'correction', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      o.at ?? T0,
      o.from,
      o.at ?? T0,
      o.dmarc ?? null,
      o.senderAuth ?? null,
      o.raw ?? null,
      o.orig === undefined ? "not_forwarded" : o.orig,
      o.inReplyTo ?? null,
      o.refs ?? null,
      o.display ?? null
    );
}

function sent(providerMessageId: string, recipient: string, source: string) {
  raw
    .prepare(
      "INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, provider_message_id) VALUES (?, ?, ?, ?, ?)"
    )
    .run(crypto.randomUUID(), T0 - 3600, recipient, source, providerMessageId);
}

type Row = {
  promoter_id: string;
  email: string;
  name: string | null;
  validation_method: string;
  validation_evidence: string | null;
  inbound_email_id: string | null;
  sender_auth: string | null;
  auth_domain: string | null;
  auth_domain_matches_promoter: number | null;
  status: string;
  first_validated_at: number | null;
  last_heard_at: number | null;
};
const contacts = () =>
  raw.prepare("SELECT * FROM promoter_contacts ORDER BY created_at, email").all() as Row[];
const actions = () =>
  raw
    .prepare(
      "SELECT action FROM admin_actions WHERE target_type = 'promoter_contact' ORDER BY created_at"
    )
    .all() as Array<{ action: string }>;
const capture = (inboundId: string, now = new Date((T0 + 60) * 1000)) =>
  capturePromoterContacts(db, inboundId, `wf-${inboundId}`, now);

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

describe("the two real specimens land as candidates", () => {
  it("e188a9f7 — own domain, dmarc=none, Yahoo-signed: candidate, domain match TRUE (case b, real)", async () => {
    promoter("d97d6357", "https://garlicfestct.com/", "contact@garlicfestct.com");
    sent(
      "<HoYNa7BRLZK0ddErktGE6KMmK3qcPfNqoqCg@meetmeatthefair.com>",
      "contact@garlicfestct.com",
      "content-links-sync.promoter-mention"
    );
    inbound("e188a9f7", {
      from: "contact@garlicfestct.com",
      dmarc: "none",
      senderAuth: "partial",
      raw: GARLIC_RAW,
      inReplyTo: "<HoYNa7BRLZK0ddErktGE6KMmK3qcPfNqoqCg@meetmeatthefair.com>",
      refs: "<HoYNa7BRLZK0ddErktGE6KMmK3qcPfNqoqCg@meetmeatthefair.com>",
    });
    const s = await capture("e188a9f7");
    expect(s).toMatchObject({ promoters: 1, inserted: 1, promoted: 0 });
    const [c] = contacts();
    expect(c).toMatchObject({
      promoter_id: "d97d6357",
      email: "contact@garlicfestct.com",
      name: null,
      validation_method: "replied_to_our_mail",
      inbound_email_id: "e188a9f7",
      sender_auth: "partial",
      auth_domain: "garlicfestct.com",
      auth_domain_matches_promoter: 1,
      status: "candidate",
      first_validated_at: null,
      last_heard_at: T0,
    });
    // both bases found it: the published address AND the reply to our blog notice
    expect(c.validation_evidence).toContain("contact-email + reply-to-our-mail");
    expect(c.validation_evidence).toContain("dmarc=none");
    expect(actions()).toEqual([{ action: "promoter_contact.captured" }]);
  });

  it("ae679c84 — Gmail, DMARC pass on gmail.com: candidate, domain match FALSE (case c, real)", async () => {
    promoter("3718a702", "https://christmasprelude.com", "christmasprelude@gmail.com");
    inbound("ae679c84", {
      from: "christmasprelude@gmail.com",
      dmarc: "pass",
      senderAuth: "pass",
      raw: PRELUDE_RAW,
      display: "Christmas Prelude Kennebunkport",
    });
    await capture("ae679c84");
    expect(contacts()).toEqual([
      expect.objectContaining({
        promoter_id: "3718a702",
        name: "Christmas Prelude Kennebunkport",
        status: "candidate",
        validation_method: "replied_to_our_mail",
        sender_auth: "pass",
        auth_domain: "gmail.com",
        auth_domain_matches_promoter: 0,
      }),
    ]);
  });
});

describe("repeats", () => {
  it("a second inbound from the same address bumps last_heard_at only — no duplicate, no new audit row", async () => {
    promoter("p1", "https://garlicfestct.com/", "contact@garlicfestct.com");
    inbound("m1", {
      from: "contact@garlicfestct.com",
      dmarc: "none",
      senderAuth: "partial",
      raw: GARLIC_RAW,
      display: "First Name",
    });
    await capture("m1");
    inbound("m2", {
      from: "CONTACT@GarlicFestCT.com",
      dmarc: "none",
      senderAuth: "partial",
      raw: GARLIC_RAW,
      display: "Other Name",
      at: T0 + 86400,
    });
    const s = await capture("m2", new Date((T0 + 86460) * 1000));
    expect(s).toMatchObject({ inserted: 0, refreshed: 1 });
    const rows = contacts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      last_heard_at: T0 + 86400,
      name: "First Name",
      inbound_email_id: "m1",
    });
    expect(actions()).toHaveLength(1);
  });

  it("replaying the SAME inbound (workflow retry) changes nothing", async () => {
    promoter("p1", "https://garlicfestct.com/", "contact@garlicfestct.com");
    inbound("m1", { from: "contact@garlicfestct.com", dmarc: "none", raw: GARLIC_RAW });
    await capture("m1");
    const s = await capture("m1");
    expect(s).toMatchObject({ inserted: 0, refreshed: 0, unchanged: 1 });
    expect(contacts()).toHaveLength(1);
  });
});

describe("who never becomes a contact", () => {
  it("a fair-goer who merely MENTIONS a promoter creates no row (and the step still records)", async () => {
    promoter("p1", "https://garlicfestct.com/", "contact@garlicfestct.com");
    inbound("fan", {
      from: "fan@gmail.com",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("gmail.com"),
    });
    const s = await capture("fan");
    expect(s.promoters).toBe(0);
    expect(contacts()).toEqual([]);
    const steps = raw
      .prepare(
        "SELECT step_name, inbound_email_id FROM workflow_run_steps WHERE step_name = 'promoter-contacts/capture'"
      )
      .all();
    expect(steps).toEqual([{ step_name: "promoter-contacts/capture", inbound_email_id: "fan" }]);
  });

  it("our own domain is never captured", async () => {
    promoter("p1", "https://meetmeatthefair.com", "notify@meetmeatthefair.com");
    inbound("own", {
      from: "notify@meetmeatthefair.com",
      dmarc: "pass",
      raw: passRaw("meetmeatthefair.com"),
    });
    expect(await capture("own")).toMatchObject({ skipped: "own-domain" });
    expect(contacts()).toEqual([]);
  });
});

describe("domain verification (scope item 6) — each case on its own", () => {
  it("(a) DMARC pass on the promoter's own website domain → validated / domain_verified", async () => {
    promoter("p1", "https://www.grangefair.org", "office@grangefair.org");
    inbound("a", {
      from: "office@grangefair.org",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("grangefair.org"),
    });
    await capture("a");
    const [c] = contacts();
    expect(c).toMatchObject({
      status: "validated",
      validation_method: "domain_verified",
      auth_domain: "grangefair.org",
      auth_domain_matches_promoter: 1,
      first_validated_at: T0 + 60,
    });
    expect(actions()).toEqual([{ action: "promoter_contact.auto_validated" }]);
  });

  it("(b) the same domain with dmarc=none stays candidate, with domain match TRUE", async () => {
    promoter("p1", "https://www.grangefair.org", "office@grangefair.org");
    inbound("b", {
      from: "office@grangefair.org",
      dmarc: "none",
      raw: "mx; dkim=pass header.d=yahoo.com; dmarc=none header.from=grangefair.org",
    });
    await capture("b");
    expect(contacts()[0]).toMatchObject({ status: "candidate", auth_domain_matches_promoter: 1 });
  });

  it("(c) DMARC pass on gmail.com for a promoter whose contact address is Gmail stays candidate", async () => {
    promoter("p1", "https://gmail.com", "fairfolks@gmail.com");
    inbound("c", {
      from: "fairfolks@gmail.com",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("gmail.com"),
    });
    await capture("c");
    expect(contacts()[0]).toMatchObject({ status: "candidate", auth_domain_matches_promoter: 0 });
  });

  it("(d) DMARC pass on a shared host that is ALSO the promoter's website host stays candidate", async () => {
    promoter("p1", "https://www.facebook.com/somefair", "somefair@facebook.com");
    inbound("d", {
      from: "somefair@facebook.com",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("facebook.com"),
    });
    await capture("d");
    expect(contacts()[0]).toMatchObject({ status: "candidate", auth_domain_matches_promoter: 0 });
  });

  it("(e) a forwarded message stays candidate even on the promoter's own domain with DMARC pass", async () => {
    promoter("p1", "https://www.grangefair.org", "office@grangefair.org");
    inbound("e", {
      from: "office@grangefair.org",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("grangefair.org"),
      orig: "verified",
    });
    await capture("e");
    expect(contacts()[0]).toMatchObject({ status: "candidate", auth_domain_matches_promoter: 1 });
    expect(contacts()[0].validation_evidence).toContain("original_sender_auth=verified");
  });

  it("(f) a subdomain sender matches the promoter's organizational domain", async () => {
    promoter("p1", "https://www.example.org", "events@mail.example.org");
    inbound("f", {
      from: "events@mail.example.org",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("mail.example.org"),
    });
    await capture("f");
    expect(contacts()[0]).toMatchObject({
      status: "validated",
      validation_method: "domain_verified",
      auth_domain: "mail.example.org",
      auth_domain_matches_promoter: 1,
    });
  });
});

describe("promotion", () => {
  it("an existing candidate is promoted when a later message from the same address qualifies", async () => {
    promoter("p1", "https://www.grangefair.org", "office@grangefair.org");
    inbound("m1", {
      from: "office@grangefair.org",
      dmarc: "none",
      raw: "mx; dmarc=none header.from=grangefair.org",
    });
    await capture("m1");
    inbound("m2", {
      from: "office@grangefair.org",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("grangefair.org"),
      at: T0 + 100,
    });
    const s = await capture("m2", new Date((T0 + 200) * 1000));
    expect(s).toMatchObject({ promoted: 1 });
    expect(contacts()[0]).toMatchObject({
      status: "validated",
      validation_method: "domain_verified",
      inbound_email_id: "m2",
      first_validated_at: T0 + 200,
      last_heard_at: T0 + 100,
    });
    expect(actions().map((a) => a.action)).toEqual([
      "promoter_contact.captured",
      "promoter_contact.auto_validated",
    ]);
  });

  it("a REJECTED row is never auto-promoted (only last_heard_at moves)", async () => {
    promoter("p1", "https://www.grangefair.org", "office@grangefair.org");
    inbound("m1", {
      from: "office@grangefair.org",
      dmarc: "none",
      raw: "mx; dmarc=none header.from=grangefair.org",
    });
    await capture("m1");
    raw.prepare("UPDATE promoter_contacts SET status = 'rejected'").run();
    inbound("m2", {
      from: "office@grangefair.org",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("grangefair.org"),
      at: T0 + 100,
    });
    const s = await capture("m2");
    expect(s.promoted).toBe(0);
    expect(contacts()[0]).toMatchObject({ status: "rejected", last_heard_at: T0 + 100 });
  });
});

describe("a threaded reply to mail we sent that promoter", () => {
  it("a DIFFERENT address replying to our blog notice is captured for the promoter we wrote to", async () => {
    promoter("p1", "https://garlicfestct.com/", "contact@garlicfestct.com");
    sent(
      "<notice-1@meetmeatthefair.com>",
      "contact@garlicfestct.com",
      "content-links-sync.promoter-mention"
    );
    inbound("r1", {
      from: "david@garlicfestct.com",
      dmarc: "none",
      raw: "mx; dmarc=none header.from=garlicfestct.com",
      inReplyTo: "notice-1@meetmeatthefair.com", // bare form: the ledger stores <…>
      display: "David Harkness",
    });
    await capture("r1");
    expect(contacts()).toEqual([
      expect.objectContaining({
        promoter_id: "p1",
        email: "david@garlicfestct.com",
        name: "David Harkness",
        status: "candidate",
      }),
    ]);
    expect(contacts()[0].validation_evidence).toContain("reply-to-our-mail");
  });

  it("a blog notice that went to the OWNER account (no contact_email) still traces to its promoter", async () => {
    raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'owner@somewhere.org')").run();
    promoter("p1", "https://somewhere.org", null, "u1");
    sent(
      "<notice-2@meetmeatthefair.com>",
      "owner@somewhere.org",
      "content-links-sync.promoter-mention"
    );
    inbound("r2", {
      from: "owner@somewhere.org",
      dmarc: "none",
      refs: "<x@a> <notice-2@meetmeatthefair.com>",
    });
    await capture("r2");
    expect(contacts()).toHaveLength(1);
    expect(contacts()[0].promoter_id).toBe("p1");
  });

  it("a reply to promoter OUTREACH traces through promoter_outreach_attempts", async () => {
    promoter("p1", "https://somewhere.org", null);
    raw
      .prepare(
        "INSERT INTO promoter_outreach_attempts (id, promoter_id, to_address, subject, body_text, created_at) VALUES ('a1', 'p1', 'info@somewhere.org', 's', 'b', ?)"
      )
      .run(T0);
    sent("<out-1@meetmeatthefair.com>", "info@somewhere.org", "email:promoter-outreach");
    inbound("r3", {
      from: "info@somewhere.org",
      dmarc: "none",
      inReplyTo: "<out-1@meetmeatthefair.com>",
    });
    await capture("r3");
    expect(contacts().map((c) => c.promoter_id)).toEqual(["p1"]);
  });

  it("a reply to an OPERATOR email traces through operator_outbound_drafts (promoter-related only)", async () => {
    promoter("p1", "https://somewhere.org", null);
    raw
      .prepare(
        "INSERT INTO operator_outbound_drafts (id, to_address, subject, body_text, reason, composed_at, related_entity_type, related_entity_id) VALUES ('d1', 'info@somewhere.org', 's', 'b', 'r', ?, 'promoter', 'p1')"
      )
      .run(T0);
    sent("<op-1@meetmeatthefair.com>", "info@somewhere.org", "operator:outbound");
    inbound("r4", {
      from: "info@somewhere.org",
      dmarc: "none",
      inReplyTo: "<op-1@meetmeatthefair.com>",
    });
    await capture("r4");
    expect(contacts().map((c) => c.promoter_id)).toEqual(["p1"]);
  });

  it("a reply to a NON-promoter send of ours (e.g. a reply to a fair-goer) creates nothing", async () => {
    promoter("p1", "https://garlicfestct.com/", "contact@garlicfestct.com");
    sent("<ack-1@meetmeatthefair.com>", "contact@garlicfestct.com", "reply:photo-intake-ack");
    inbound("r5", {
      from: "someone@garlicfestct.com",
      dmarc: "none",
      inReplyTo: "<ack-1@meetmeatthefair.com>",
    });
    await capture("r5");
    expect(contacts()).toEqual([]);
  });

  it("a recipient that traces to TWO promoters is ambiguous: no row", async () => {
    promoter("p1", "https://a.org", "shared@office.org");
    promoter("p2", "https://b.org", "shared@office.org");
    sent(
      "<notice-3@meetmeatthefair.com>",
      "shared@office.org",
      "content-links-sync.promoter-mention"
    );
    inbound("r6", {
      from: "someone@office.org",
      dmarc: "none",
      inReplyTo: "<notice-3@meetmeatthefair.com>",
    });
    const s = await capture("r6");
    expect(s.ambiguousThreads).toBe(1);
    expect(contacts()).toEqual([]);
  });
});
