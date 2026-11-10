/**
 * OPE-1610 — a DMARC-aligned organizer with no promoter row is kept, and joins
 * the promoter when one appears. Against a real database. The auth values are
 * 7f761f2a's own, copied from prod D1 on 2026-11-10.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, type TestDb } from "./setup-db.js";
import { capturePromoterContacts } from "../src/inbound/promoter-contact-capture.js";
import { attachPendingPromoterContacts } from "../src/inbound/pending-promoter-contact-attach.js";

let db: TestDb;
let raw: Database.Database;
const T0 = Math.floor(Date.UTC(2026, 10, 10, 14, 10) / 1000);
const FROM = "sgasiorowski@ohtm.org";
const VENDOR_ID = "615c32df-d58e-473d-b554-3f9cf59d98a4";
const OHTM_RAW =
  'mx.cloudflare.net; dkim=pass header.d=ohtm-org.20260707.gappssmtp.com header.s=20260707; dmarc=pass header.from=ohtm.org policy.dmarc=none; spf=pass smtp.mailfrom=sgasiorowski@ohtm.org; arc=pass smtp.remote-ip="2607:f8b0:4864:20::f31"';
const VENDOR_MATCH = JSON.stringify([
  {
    entityType: "vendor",
    entityId: VENDOR_ID,
    name: "Owls Head Transportation Museum",
    basis: "website-domain",
    matchedOn: "ohtm.org",
    confidence: 0.7,
  },
]);

function inbound(
  id: string,
  o: {
    from?: string;
    dmarc?: string | null;
    raw?: string | null;
    orig?: string | null;
    matched?: string | null;
    at?: number;
  } = {}
) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at,
         dmarc_result, sender_auth, auth_results_raw, original_sender_auth, from_display_name, matched_entities)
       VALUES (?, ?, ?, 'hello@meetmeatthefair.com', 'support', ?, ?, 'pass', ?, ?, 'Samantha Gasiorowski', ?)`
    )
    .run(
      id,
      o.at ?? T0,
      o.from ?? FROM,
      o.at ?? T0,
      o.dmarc === undefined ? "pass" : o.dmarc,
      o.raw === undefined ? OHTM_RAW : o.raw,
      o.orig === undefined ? "not_forwarded" : o.orig,
      o.matched === undefined ? VENDOR_MATCH : o.matched
    );
}

function promoter(id: string, website: string | null) {
  raw
    .prepare("INSERT INTO promoters (id, company_name, slug, website) VALUES (?, ?, ?, ?)")
    .run(id, `Promoter ${id}`, `promoter-${id}`, website);
}

const pendingRows = () => raw.prepare("SELECT * FROM pending_promoter_contacts").all() as never[];
const contacts = () =>
  raw.prepare("SELECT promoter_id, email, status, validation_method FROM promoter_contacts").all();

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

describe("capture keeps an organizer with no promoter row", () => {
  it("replaying 7f761f2a records a pending contact linked to its vendor", async () => {
    inbound("7f761f2a");
    const s = await capturePromoterContacts(db, "7f761f2a", "wf");
    expect(s.pendingContact).toBe(true);
    expect(s.inserted).toBe(0);
    expect(contacts()).toEqual([]);
    expect(pendingRows()).toEqual([
      expect.objectContaining({
        email: FROM,
        org_domain: "ohtm.org",
        status: "pending",
        name: "Samantha Gasiorowski",
        matched_entity_type: "vendor",
        matched_entity_id: VENDOR_ID,
        inbound_email_id: "7f761f2a",
        sender_auth: "pass",
        auth_domain: "ohtm.org",
        first_validated_at: T0,
      }),
    ]);
  });

  it("records an org with no record on file at all", async () => {
    inbound("a", { matched: null });
    await capturePromoterContacts(db, "a", "wf");
    expect(pendingRows()).toEqual([
      expect.objectContaining({ matched_entity_type: null, matched_entity_id: null }),
    ]);
  });

  it("does not treat a brand-name match as the org's record", async () => {
    inbound("a", {
      matched: JSON.stringify([{ entityType: "vendor", entityId: "x", basis: "brand-name" }]),
    });
    await capturePromoterContacts(db, "a", "wf");
    expect(pendingRows()).toEqual([expect.objectContaining({ matched_entity_id: null })]);
  });

  it("a later message refreshes the row but keeps when it was first validated", async () => {
    inbound("a");
    await capturePromoterContacts(db, "a", "wf");
    inbound("b", { at: T0 + 500 });
    await capturePromoterContacts(db, "b", "wf");
    expect(pendingRows()).toEqual([
      expect.objectContaining({
        inbound_email_id: "b",
        first_validated_at: T0,
        last_heard_at: T0 + 500,
      }),
    ]);
  });

  const refused: Array<[string, Parameters<typeof inbound>[1]]> = [
    ["DMARC fail", { dmarc: "fail", raw: OHTM_RAW.replace("dmarc=pass", "dmarc=fail") }],
    ["no DMARC", { dmarc: null, raw: OHTM_RAW.replace("dmarc=pass", "dmarc=none") }],
    [
      "a DMARC pass aligned to a different domain",
      { raw: OHTM_RAW.replace("header.from=ohtm.org", "header.from=other-domain.org") },
    ],
    ["a forward", { orig: "forwarded" }],
    ["a free-mail sender", { from: "someone@gmail.com", raw: null }],
  ];
  it.each(refused)("%s records nothing", async (_label, opts) => {
    inbound("a", opts);
    const s = await capturePromoterContacts(db, "a", "wf");
    expect(s.pendingContact).toBe(false);
    expect(pendingRows()).toEqual([]);
  });

  it("does not record a pending row when a promoter already owns the domain", async () => {
    promoter("p1", "https://www.ohtm.org/");
    inbound("a");
    const s = await capturePromoterContacts(db, "a", "wf");
    expect(s.inserted).toBe(1);
    expect(pendingRows()).toEqual([]);
  });
});

describe("attachPendingPromoterContacts", () => {
  const seed = async () => {
    inbound("7f761f2a");
    await capturePromoterContacts(db, "7f761f2a", "wf");
  };

  it("leaves the row pending until a promoter owns the domain, and says it looked", async () => {
    await seed();
    expect(await attachPendingPromoterContacts(db)).toEqual({
      examined: 1,
      attached: 0,
      notQualified: 0,
    });
    expect(pendingRows()).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("attaches automatically once a promoter row for the domain is created", async () => {
    await seed();
    promoter("ohtm", "https://ohtm.org/");
    expect((await attachPendingPromoterContacts(db)).attached).toBe(1);
    expect(contacts()).toEqual([
      {
        promoter_id: "ohtm",
        email: FROM,
        status: "validated",
        validation_method: "domain_verified",
      },
    ]);
    expect(pendingRows()).toEqual([
      expect.objectContaining({ status: "attached", attached_promoter_id: "ohtm" }),
    ]);
    expect(
      raw.prepare("SELECT action FROM admin_actions WHERE target_type='promoter_contact'").all()
    ).toEqual([{ action: "promoter_contact.auto_validated" }]);
  });

  it("is a no-op on the next run", async () => {
    await seed();
    promoter("ohtm", "https://ohtm.org/");
    await attachPendingPromoterContacts(db);
    expect(await attachPendingPromoterContacts(db)).toEqual({
      examined: 0,
      attached: 0,
      notQualified: 0,
    });
  });

  it("waits when two promoters claim the domain", async () => {
    await seed();
    promoter("a", "https://ohtm.org/");
    promoter("b", "https://www.ohtm.org/events");
    expect((await attachPendingPromoterContacts(db)).attached).toBe(0);
    expect(contacts()).toEqual([]);
  });

  it("does not revive a contact a person rejected", async () => {
    await seed();
    promoter("ohtm", "https://ohtm.org/");
    raw
      .prepare(
        `INSERT INTO promoter_contacts (id, promoter_id, email, validation_method, status, created_at, updated_at)
         VALUES ('c1', 'ohtm', ?, 'self_asserted', 'rejected', ?, ?)`
      )
      .run(FROM, T0, T0);
    await attachPendingPromoterContacts(db);
    expect(contacts()).toEqual([
      expect.objectContaining({ promoter_id: "ohtm", status: "rejected" }),
    ]);
  });

  it("re-checks the verdict against the real website", async () => {
    await seed();
    promoter("ohtm", "https://ohtm.org/");
    raw.prepare("UPDATE inbound_emails SET dmarc_result='fail' WHERE id='7f761f2a'").run();
    expect(await attachPendingPromoterContacts(db)).toEqual({
      examined: 1,
      attached: 0,
      notQualified: 1,
    });
    expect(contacts()).toEqual([]);
  });
});
