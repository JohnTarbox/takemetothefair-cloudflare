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
import {
  captureNeedsWarning,
  capturePromoterContacts,
} from "../src/inbound/promoter-contact-capture.js";

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
    matched?: string | null;
  }
) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at,
         dmarc_result, sender_auth, auth_results_raw, original_sender_auth, in_reply_to, email_references, from_display_name,
         matched_entities)
       VALUES (?, ?, ?, 'submit@meetmeatthefair.com', 'correction', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      o.display ?? null,
      o.matched ?? null
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
    // A sender OFF the promoter's domain: on garlicfestct.com the website-domain
    // basis (rework) would rightly capture them, which is not what this pins.
    inbound("r5", {
      from: "someone@elsewhere-example.org",
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

// ── Rework (review 2026-10-15) ───────────────────────────────────────────────
// The specimen: three inbound rows on 2026-10-14 17:18Z (13931b4c, 5c1fa4e5,
// b8afb8fb) from a person at a promoter's own company domain. Field shapes are
// copied from prod D1; the domains are replaced with example ones and the
// person's address is not reproduced. Prod facts that matter:
//   - matched_entities = one promoter, basis `website-domain`, confidence 0.7;
//   - dmarc_result pass, sender_auth pass, original_sender_auth not_forwarded;
//   - DMARC aligned via SPF; DKIM signed by the Google Workspace host;
//   - in_reply_to names OUR mail, but that send's ledger source is
//     `reply:manual` (an operator reply), which is not promoter-addressed;
//   - the promoter's contact_email is a DIFFERENT domain (a brand mailbox);
//   - a validated row for the sender already existed, written by hand, with
//     last_heard_at NULL — and capture recorded {"promoters":0,…} as `ok`.
const DAN_DOMAIN = "broadcast-example.com";
const DAN_FROM = `staff.person@${DAN_DOMAIN}`;
const DAN_PROMOTER = "46e1a3f4-0000-4000-8000-000000000001";
const DAN_REPLY_TO = "<zl0DrzveExampleExampleExample@meetmeatthefair.com>";
const DAN_RAW =
  `mx.cloudflare.net; dkim=pass header.d=broadcast-example-com.20251104.gappssmtp.com header.s=20251104 header.b=Qr+LVZ9k; ` +
  `dmarc=pass header.from=${DAN_DOMAIN} policy.dmarc=none; spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-lf1-x129.google.com) smtp.helo=mail-lf1-x129.google.com; ` +
  `spf=pass (mx.cloudflare.net: domain of ${DAN_FROM} designates 2a00:1450:4864:20::129 as permitted sender) smtp.mailfrom=${DAN_FROM}; arc=pass smtp.`;
const DAN_MATCHED = JSON.stringify([
  {
    entityType: "promoter",
    entityId: DAN_PROMOTER,
    name: "Example Media",
    slug: "example-media",
    basis: "website-domain",
    matchedOn: DAN_DOMAIN,
    confidence: 0.7,
  },
]);
const DAN_AT = 1791998289; // 2026-10-14 17:18:09Z

function danPromoter() {
  promoter(DAN_PROMOTER, `https://www.${DAN_DOMAIN}`, "info@lightshow-example.com");
}
function danInbound(id: string, at = DAN_AT) {
  sent(DAN_REPLY_TO, DAN_FROM, "reply:manual");
  inbound(id, {
    from: DAN_FROM,
    display: "Staff Person",
    dmarc: "pass",
    senderAuth: "pass",
    raw: DAN_RAW,
    orig: "not_forwarded",
    inReplyTo: DAN_REPLY_TO,
    refs: `<CAKLP-example@mail.gmail.com> ${DAN_REPLY_TO}`,
    matched: DAN_MATCHED,
    at,
  });
}
const stepRows = () =>
  raw
    .prepare(
      "SELECT inbound_email_id, status, detail FROM workflow_run_steps WHERE step_name = 'promoter-contacts/capture' ORDER BY recorded_at"
    )
    .all() as Array<{ inbound_email_id: string; status: string; detail: string }>;

describe("website-domain: a sender from the promoter's own website domain (the 10-14 specimen)", () => {
  it("the existing hand-written validated row gets last_heard_at set — and nothing else changes", async () => {
    danPromoter();
    raw
      .prepare(
        `INSERT INTO promoter_contacts (id, promoter_id, email, name, validation_method, validation_evidence,
           status, first_validated_at, last_heard_at, created_by, updated_by, created_at, updated_at)
         VALUES ('c-dan', ?, ?, 'Staff Person', 'domain_verified', 'hand-written evidence', 'validated', ?, NULL, 'admin', 'admin', ?, ?)`
      )
      .run(DAN_PROMOTER, DAN_FROM, DAN_AT - 3591, DAN_AT - 3591, DAN_AT - 3591);
    danInbound("13931b4c");

    const s = await capture("13931b4c", new Date((DAN_AT + 60) * 1000));
    expect(s).toMatchObject({
      outcome: "captured",
      promoters: 1,
      resolverPromoters: 1,
      refreshed: 1,
      inserted: 0,
      notCaptured: [],
    });
    const [c] = contacts();
    expect(c).toMatchObject({
      promoter_id: DAN_PROMOTER,
      email: DAN_FROM,
      status: "validated",
      validation_method: "domain_verified",
      validation_evidence: "hand-written evidence",
      last_heard_at: DAN_AT,
    });
    expect(actions()).toEqual([]);
    expect(stepRows()[0]).toMatchObject({ inbound_email_id: "13931b4c", status: "ok" });
    expect(JSON.parse(stepRows()[0].detail).outcome).toBe("captured");
    expect(captureNeedsWarning(s)).toBe(false);
  });

  it("with no prior row it is written validated / domain_verified (DMARC pass on the website domain)", async () => {
    danPromoter();
    danInbound("5c1fa4e5");
    const s = await capture("5c1fa4e5", new Date((DAN_AT + 60) * 1000));
    expect(s).toMatchObject({ outcome: "captured", inserted: 1 });
    expect(contacts()).toEqual([
      expect.objectContaining({
        promoter_id: DAN_PROMOTER,
        email: DAN_FROM,
        name: "Staff Person",
        status: "validated",
        validation_method: "domain_verified",
        sender_auth: "pass",
        auth_domain: DAN_DOMAIN,
        auth_domain_matches_promoter: 1,
        last_heard_at: DAN_AT,
      }),
    ]);
    expect(contacts()[0].validation_evidence).toContain("website-domain");
    expect(actions()).toEqual([{ action: "promoter_contact.auto_validated" }]);
  });

  it("the same domain WITHOUT DMARC pass is only a candidate, self_asserted", async () => {
    promoter("p1", "https://www.grangefair.org", null);
    inbound("wd1", {
      from: "volunteer@grangefair.org",
      dmarc: "none",
      raw: "mx; dmarc=none header.from=grangefair.org",
    });
    await capture("wd1");
    expect(contacts()).toEqual([
      expect.objectContaining({
        promoter_id: "p1",
        status: "candidate",
        validation_method: "self_asserted",
        auth_domain_matches_promoter: 1,
      }),
    ]);
  });

  it("a subdomain sender matches on the ORGANIZATIONAL domain", async () => {
    promoter("p1", "https://www.grangefair.org/events", null);
    inbound("wd2", { from: "office@mail.grangefair.org", dmarc: "none" });
    await capture("wd2");
    expect(contacts().map((c) => c.promoter_id)).toEqual(["p1"]);
  });

  it("a look-alike domain that merely CONTAINS the website domain is not a match", async () => {
    promoter("p1", "https://grangefair.org", null);
    promoter("p2", "https://www.example.org.uk-example.net/x", null);
    inbound("wd3", {
      from: "x@notgrangefair.org",
      dmarc: "pass",
      raw: passRaw("notgrangefair.org"),
    });
    inbound("wd4", { from: "x@grangefair.org.evil-example.net", dmarc: "none" });
    // the sender's domain is a SUBSTRING of a stored website (the instr prefilter hits)
    inbound("wd7", { from: "x@fair.org", dmarc: "pass", raw: passRaw("fair.org") });
    inbound("wd8", { from: "x@example.org", dmarc: "pass", raw: passRaw("example.org") });
    for (const id of ["wd3", "wd4", "wd7", "wd8"]) await capture(id);
    expect(contacts()).toEqual([]);
  });

  it("a free-mail sender is never matched on domain, even to a promoter whose 'website' is that host", async () => {
    promoter("p1", "https://www.facebook.com/somefair", null);
    promoter("p2", "https://gmail.com", null);
    inbound("wd5", { from: "anyone@gmail.com", dmarc: "pass", raw: passRaw("gmail.com") });
    inbound("wd6", { from: "anyone@facebook.com", dmarc: "pass", raw: passRaw("facebook.com") });
    await capture("wd5");
    await capture("wd6");
    expect(contacts()).toEqual([]);
  });

  it("a fair-goer who MENTIONS the promoter (brand-name match only) creates no row", async () => {
    promoter("p1", "https://www.grangefair.org", "office@grangefair.org");
    inbound("fan2", {
      from: "fan@gmail.com",
      dmarc: "pass",
      raw: passRaw("gmail.com"),
      matched: JSON.stringify([
        { entityType: "promoter", entityId: "p1", basis: "brand-name", confidence: 0.4 },
      ]),
    });
    const s = await capture("fan2");
    expect(contacts()).toEqual([]);
    expect(s.outcome).toBe("matched_not_captured");
    expect(s.notCaptured).toEqual([
      expect.objectContaining({ promoterId: "p1", basis: "brand-name", expected: true }),
    ]);
    expect(captureNeedsWarning(s)).toBe(false);
  });
});

describe("matched but captured 0 is its own outcome, never a plain ok", () => {
  it("a website-domain match on a domain two promoters share: matched_not_captured, status skipped, with reason", async () => {
    promoter("p1", "https://www.shared-example.org/fair-a", null);
    promoter("p2", "https://shared-example.org/fair-b", null);
    inbound("amb", {
      from: "clerk@shared-example.org",
      dmarc: "pass",
      raw: passRaw("shared-example.org"),
      matched: JSON.stringify([
        { entityType: "promoter", entityId: "p1", basis: "website-domain" },
        { entityType: "promoter", entityId: "p2", basis: "website-domain" },
      ]),
    });
    const s = await capture("amb");
    expect(contacts()).toEqual([]);
    expect(s).toMatchObject({
      outcome: "matched_not_captured",
      promoters: 0,
      resolverPromoters: 2,
      ambiguousDomain: 1,
      alignedUnknownDomain: false,
    });
    expect(s.notCaptured.map((n) => [n.promoterId, n.expected])).toEqual([
      ["p1", true],
      ["p2", true],
    ]);
    expect(s.notCaptured[0].reason).toContain("ambiguous");
    const [step] = stepRows();
    expect(step.status).toBe("skipped");
    expect(JSON.parse(step.detail)).toMatchObject({ outcome: "matched_not_captured" });
    expect(captureNeedsWarning(s)).toBe(false);
  });

  it("a resolver match capture has NO basis for (the 10-14 shape) is unexpected and warns", async () => {
    // The resolver says contact-email for p9, but p9's contact_email is not
    // this sender and its website is elsewhere — capture and resolver disagree.
    promoter("p9", "https://elsewhere-example.org", "someone-else@elsewhere-example.org");
    inbound("gap", {
      from: "person@unrelated-example.net",
      dmarc: "pass",
      raw: passRaw("unrelated-example.net"),
      matched: JSON.stringify([{ entityType: "promoter", entityId: "p9", basis: "contact-email" }]),
    });
    const s = await capture("gap");
    expect(s.outcome).toBe("matched_not_captured");
    expect(s.notCaptured).toEqual([
      expect.objectContaining({ promoterId: "p9", basis: "contact-email", expected: false }),
    ]);
    expect(stepRows()[0].status).toBe("skipped");
    expect(captureNeedsWarning(s)).toBe(true);
  });

  it("the 10-14 run shape — resolver matched on website-domain — now captures, so no matched_not_captured", async () => {
    danPromoter();
    danInbound("b8afb8fb");
    const s = await capture("b8afb8fb");
    expect(s.outcome).toBe("captured");
    expect(stepRows()[0].status).toBe("ok");
  });
});

describe("a sender from an organizer we do not list (the 10-14 gap) — counted, not stored", () => {
  it("DMARC pass on an ownable domain that is no promoter's website: no row, no_promoter_match, alignedUnknownDomain", async () => {
    promoter("p1", "https://www.grangefair.org", "office@grangefair.org");
    inbound("unk", {
      from: "pr@new-organizer-example.com",
      dmarc: "pass",
      senderAuth: "pass",
      raw: passRaw("new-organizer-example.com"),
      matched: "[]",
    });
    const s = await capture("unk");
    expect(contacts()).toEqual([]);
    expect(s).toMatchObject({ outcome: "no_promoter_match", alignedUnknownDomain: true });
    expect(stepRows()[0].status).toBe("ok");
  });

  it("a free-mail sender with no match is NOT flagged as an unknown organizer", async () => {
    inbound("unk2", { from: "someone@gmail.com", dmarc: "pass", raw: passRaw("gmail.com") });
    const s = await capture("unk2");
    expect(s).toMatchObject({ outcome: "no_promoter_match", alignedUnknownDomain: false });
  });
});
