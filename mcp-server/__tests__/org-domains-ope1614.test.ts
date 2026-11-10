/**
 * OPE-1614 — an organization can have several domains. Against a real
 * database. The OHTM auth values are inbound 7f761f2a's own (prod D1,
 * 2026-11-10); the redirect is ohtm.org's real one (302 → owlshead.org).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  addOrgDomain,
  matchableDomainsFor,
  orgDomainList,
  orgsForDomain,
  planOrgDomainAdd,
  retireOrgDomain,
  setSharedOrgDomain,
} from "@takemetothefair/db-schema";
import { capturePromoterContacts } from "../src/inbound/promoter-contact-capture.js";
import { attachPendingPromoterContacts } from "../src/inbound/pending-promoter-contact-attach.js";
import {
  discoverOrgDomains,
  emailsOnPage,
  type FetchLike,
} from "../src/inbound/org-domain-discovery.js";
import { resolveSenderIdentity } from "../src/inbound/resolve-sender-identity.js";

let db: TestDb;
let raw: Database.Database;
const T0 = Math.floor(Date.UTC(2026, 10, 10, 14, 10) / 1000);
const NOW = new Date(Date.UTC(2026, 10, 10, 15, 0));
const FROM = "sgasiorowski@ohtm.org";
const OHTM = "3f911eef-dec6-419f-9bc1-dbb227754299";
const OHTM_RAW =
  'mx.cloudflare.net; dkim=pass header.d=ohtm-org.20260707.gappssmtp.com header.s=20260707; dmarc=pass header.from=ohtm.org policy.dmarc=none; spf=pass smtp.mailfrom=sgasiorowski@ohtm.org; arc=pass smtp.remote-ip="2607:f8b0:4864:20::f31"';

function inbound(id: string, from = FROM, rawAuth = OHTM_RAW) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at,
         dmarc_result, sender_auth, auth_results_raw, original_sender_auth, from_display_name, matched_entities)
       VALUES (?, ?, ?, 'hello@meetmeatthefair.com', 'support', ?, 'pass', 'pass', ?, 'not_forwarded', 'Samantha Gasiorowski', NULL)`
    )
    .run(id, T0, from, T0, rawAuth);
}
function promoter(id: string, website: string | null) {
  raw
    .prepare("INSERT INTO promoters (id, company_name, slug, website) VALUES (?, ?, ?, ?)")
    .run(id, `Promoter ${id}`, `promoter-${id}`, website);
}
const contacts = () =>
  raw.prepare("SELECT promoter_id, email, status FROM promoter_contacts").all();
const audits = () =>
  raw
    .prepare("SELECT action, target_type FROM admin_actions WHERE target_type = 'org_domain'")
    .all() as Array<{ action: string }>;
const sends = () =>
  raw.prepare("SELECT COUNT(*) AS n FROM email_send_ledger").get() as { n: number };

/** A fake web: url → [status, location | body]. Records every URL fetched. */
function fakeWeb(pages: Record<string, [number, string]>) {
  const fetched: string[] = [];
  const impl: FetchLike = async (url) => {
    fetched.push(url);
    const p = pages[url];
    if (!p) return new Response("", { status: 404 });
    const [status, v] = p;
    if (status >= 300 && status < 400)
      return new Response(null, { status, headers: { location: v } });
    return new Response(v, { status });
  };
  return { impl, fetched };
}
const OHTM_WEB = {
  "https://ohtm.org/": [302, "https://owlshead.org/"],
  "https://owlshead.org/": [200, '<a href="mailto:events@ohtm.org">Events</a> education@ohtm.org'],
} as Record<string, [number, string]>;

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

describe("acceptance 1 — OHTM: ohtm.org redirects to owlshead.org", () => {
  it("the hourly attach redirect-checks ohtm.org, adds it, and attaches the contact; sends nothing", async () => {
    promoter(OHTM, "https://owlshead.org");
    inbound("7f761f2a");
    // Capture first: ohtm.org is on no promoter's list yet, so it is pending.
    const cap = await capturePromoterContacts(db, "7f761f2a", "wf");
    expect(cap.pendingContact).toBe(true);
    expect(contacts()).toEqual([]);

    const web = fakeWeb(OHTM_WEB);
    const s = await attachPendingPromoterContacts(db, NOW, web.impl);
    expect(s).toMatchObject({ probed: 1, redirectAdded: 1, attached: 1 });
    expect(web.fetched).toEqual(["https://ohtm.org/", "https://owlshead.org/"]);
    expect(contacts()).toEqual([{ promoter_id: OHTM, email: FROM, status: "validated" }]);

    const list = await orgDomainList(db, "promoter", OHTM);
    expect(list.map((e) => [e.domain, e.method, e.status])).toEqual([
      ["owlshead.org", "website", "active"],
      ["ohtm.org", "website_redirect", "active"],
    ]);
    expect(list[1].evidence).toBe("redirect chain: https://ohtm.org/ → https://owlshead.org/");
    expect(audits().map((a) => a.action)).toEqual(["org_domain.added"]);
    expect(sends().n).toBe(0);
  });

  it("a replayed capture after the add resolves the contact to OHTM directly", async () => {
    promoter(OHTM, "https://owlshead.org");
    await addOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "ohtm.org",
      method: "website_redirect",
      actor: "test",
    });
    inbound("7f761f2a");
    const s = await capturePromoterContacts(db, "7f761f2a", "wf");
    expect(s.inserted).toBe(1);
    expect(contacts()).toEqual([{ promoter_id: OHTM, email: FROM, status: "validated" }]);
  });

  it("the site-published address corroborates: discovery adds ohtm.org from owlshead.org's page", async () => {
    promoter(OHTM, "https://owlshead.org");
    const web = fakeWeb(OHTM_WEB);
    const r = await discoverOrgDomains(db, "promoter", OHTM, web.impl, { now: NOW });
    expect(r.added).toEqual([
      expect.objectContaining({ domain: "ohtm.org", method: "site_published_email" }),
    ]);
    expect(await matchableDomainsFor(db, "promoter", OHTM)).toEqual(["owlshead.org", "ohtm.org"]);
  });

  it("re-probes a domain at most once a day", async () => {
    promoter(OHTM, "https://elsewhere.org");
    inbound("7f761f2a");
    await capturePromoterContacts(db, "7f761f2a", "wf");
    const web = fakeWeb(OHTM_WEB); // ohtm.org → owlshead.org, which nobody owns
    expect((await attachPendingPromoterContacts(db, NOW, web.impl)).probed).toBe(1);
    expect((await attachPendingPromoterContacts(db, NOW, web.impl)).probed).toBe(0);
    const later = new Date(NOW.getTime() + 25 * 3600 * 1000);
    expect((await attachPendingPromoterContacts(db, later, web.impl)).probed).toBe(1);
    expect(contacts()).toEqual([]);
  });

  it("the sender resolver reports the promoter once ohtm.org is on its list", async () => {
    promoter(OHTM, "https://owlshead.org");
    const before = await resolveSenderIdentity(db, { fromAddress: FROM });
    expect(before.matches.filter((m) => m.entityType === "promoter")).toEqual([]);
    await addOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "ohtm.org",
      method: "operator",
      actor: "test",
    });
    const after = await resolveSenderIdentity(db, { fromAddress: FROM });
    expect(after.matches).toContainEqual(
      expect.objectContaining({ entityType: "promoter", entityId: OHTM, basis: "website-domain" })
    );
  });
});

describe("acceptance 2 — a shared domain never auto-attaches", () => {
  it("a domain on two promoters is shared; an aligned email from it is pending and attaches nothing", async () => {
    promoter("p1", "https://grange.org/chapter-1");
    promoter("p2", "https://grange.org/chapter-2");
    const owners = await orgsForDomain(db, "promoter", "grange.org");
    expect(owners).toMatchObject({ ids: [], shared: true, allOwners: ["p1", "p2"] });
    expect(await matchableDomainsFor(db, "promoter", "p1")).toEqual([]);

    inbound("g1", "secretary@grange.org", "mx; dmarc=pass header.from=grange.org");
    const cap = await capturePromoterContacts(db, "g1", "wf");
    expect(cap).toMatchObject({ inserted: 0, ambiguousDomain: 1, pendingContact: true });
    const s = await attachPendingPromoterContacts(db, NOW, fakeWeb({}).impl);
    expect(s).toMatchObject({ shared: 1, attached: 0, probed: 0 });
    expect(contacts()).toEqual([]);
  });

  it("an operator-listed umbrella domain is shared even with one owner", async () => {
    promoter("p1", "https://townofexample.gov/recreation");
    expect((await orgsForDomain(db, "promoter", "townofexample.gov")).ids).toEqual(["p1"]);
    await setSharedOrgDomain(db, { domain: "townofexample.gov", shared: true, actor: "test" });
    expect(await orgsForDomain(db, "promoter", "townofexample.gov")).toMatchObject({
      ids: [],
      shared: true,
    });
    expect(audits().map((a) => a.action)).toEqual(["org_domain.shared_marked"]);
  });

  it("a redirect onto a shared domain adds nothing", async () => {
    promoter("p1", "https://grange.org/a");
    promoter("p2", "https://grange.org/b");
    inbound("g2", "x@oldgrange.org", "mx; dmarc=pass header.from=oldgrange.org");
    await capturePromoterContacts(db, "g2", "wf");
    const web = fakeWeb({ "https://oldgrange.org/": [301, "https://grange.org/"] });
    const s = await attachPendingPromoterContacts(db, NOW, web.impl);
    expect(s).toMatchObject({ probed: 1, redirectAdded: 0, attached: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM org_domains").get()).toEqual({ n: 0 });
  });
});

describe("acceptance 3 — what may NOT add a domain", () => {
  it("free-mail and provider domains are refused for every method", () => {
    for (const d of [
      "gmail.com",
      "yahoo.com",
      "outlook.com",
      "aol.com",
      "icloud.com",
      "facebook.com",
    ])
      for (const method of ["operator", "website_redirect", "site_published_email"] as const)
        expect(planOrgDomainAdd({ method, domain: d }).ok).toBe(false);
  });

  it("a gmail sender adds nothing to any list", async () => {
    promoter(OHTM, "https://owlshead.org");
    inbound("gm", "sender.gmail@gmail.com", "mx; dmarc=pass header.from=gmail.com");
    await capturePromoterContacts(db, "gm", "wf");
    await attachPendingPromoterContacts(db, NOW, fakeWeb({}).impl);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM org_domains").get()).toEqual({ n: 0 });
  });

  it('"we also use X" from an unvalidated sender adds nothing; from a validated one, only a candidate', async () => {
    promoter(OHTM, "https://owlshead.org");
    const unvalidated = await addOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "ohtmfestival.org",
      method: "contact_claim",
      senderValidated: false,
      actor: "test",
    });
    expect(unvalidated.ok).toBe(false);
    const validated = await addOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "ohtmfestival.org",
      method: "contact_claim",
      senderValidated: true,
      actor: "test",
    });
    expect(validated).toMatchObject({ ok: true, status: "candidate" });
    // A candidate matches nothing.
    expect(await matchableDomainsFor(db, "promoter", OHTM)).toEqual(["owlshead.org"]);
    expect((await orgsForDomain(db, "promoter", "ohtmfestival.org")).ids).toEqual([]);
  });

  it("emails on a page skip asset names that look like addresses", () => {
    expect(emailsOnPage('<img src="logo@2x.png"> Write to Info@Example.org')).toEqual([
      "info@example.org",
    ]);
  });

  it("a site page that redirected off the org's own domain is not its own site", async () => {
    promoter(OHTM, "https://owlshead.org");
    const impl: FetchLike = async () => {
      const r = new Response("contact: someone@unrelated.org", { status: 200 });
      Object.defineProperty(r, "url", { value: "https://unrelated.org/" });
      return r;
    };
    const r = await discoverOrgDomains(db, "promoter", OHTM, impl, { now: NOW });
    expect(r.added).toEqual([]);
  });
});

describe("acceptance 5 — adds and retires are audit-logged; a retire sticks", () => {
  it("retiring the website member withdraws it; automation cannot re-add a retired domain", async () => {
    promoter(OHTM, "https://owlshead.org");
    await addOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "ohtm.org",
      method: "operator",
      actor: "operator:u1",
    });
    await retireOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "owlshead.org",
      actor: "operator:u1",
      reason: "old site",
    });
    await retireOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "ohtm.org",
      actor: "operator:u1",
    });
    expect(await matchableDomainsFor(db, "promoter", OHTM)).toEqual([]);
    expect((await orgsForDomain(db, "promoter", "owlshead.org")).ids).toEqual([]);

    const auto = await addOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "ohtm.org",
      method: "website_redirect",
      actor: "system:x",
    });
    expect(auto).toMatchObject({ ok: true, changed: false, status: "retired" });
    const op = await addOrgDomain(db, {
      entityType: "promoter",
      entityId: OHTM,
      domain: "ohtm.org",
      method: "operator",
      actor: "operator:u1",
    });
    expect(op).toMatchObject({ ok: true, changed: true, status: "active" });
    expect(audits().map((a) => a.action)).toEqual([
      "org_domain.added",
      "org_domain.retired",
      "org_domain.retired",
      "org_domain.added",
    ]);
  });

  it("a subdomain address and its registrable domain match deliberately; a public suffix never does", async () => {
    promoter(OHTM, "https://www.owlshead.org/visit");
    expect((await orgsForDomain(db, "promoter", "events.owlshead.org")).ids).toEqual([OHTM]);
    expect(planOrgDomainAdd({ method: "operator", domain: "co.uk" }).ok).toBe(false);
    expect(planOrgDomainAdd({ method: "operator", domain: "org" }).ok).toBe(false);
  });
});
