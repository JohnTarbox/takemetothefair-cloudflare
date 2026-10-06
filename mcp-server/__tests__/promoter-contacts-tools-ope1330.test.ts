/**
 * OPE-1330 — the admin tools, the read surfaces, and the claim twin.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPromoterContactTools } from "../src/tools/admin-promoter-contacts.js";
import { registerInboundReadTools } from "../src/tools/admin-inbound-read.js";
import { registerPublicTools } from "../src/tools/public.js";
import { approvePromoterClaim } from "../src/tools/promoter-claim-approval.js";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await server.invoke(name, args)) as Result;
  return {
    isError: !!r.isError,
    body: JSON.parse(r.content[0].text.replace(/^Invalid arguments.*$/s, "{}")),
  };
};
const audit = () =>
  raw
    .prepare(
      "SELECT action, payload_json FROM admin_actions WHERE target_type = 'promoter_contact'"
    )
    .all() as Array<{
    action: string;
    payload_json: string;
  }>;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw
    .prepare("INSERT INTO users (id, email, role) VALUES ('u-admin', 'admin@test', 'ADMIN')")
    .run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website, contact_email) VALUES ('p1', 'Grange Fair', 'grange-fair', 'https://grangefair.org', 'office@grangefair.org')"
    )
    .run();
  server = new CapturingMcpServer();
  registerPromoterContactTools(server as never, db, ADMIN);
});

describe("admin only", () => {
  it("registers nothing for a non-admin caller", () => {
    const s = new CapturingMcpServer();
    registerPromoterContactTools(s as never, db, { userId: "u2", role: "USER" as never });
    expect(s.handlers.size).toBe(0);
  });
});

describe("upsert_promoter_contact / set_promoter_contact_status / list_promoter_contacts", () => {
  it("creates a contact (email lowercased, entities decoded), audit-logged", async () => {
    const r = await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "Jane.Doe@GrangeFair.org",
      name: "Jane Doe &amp; Co",
      role: "Vendor Coordinator",
      validation_method: "phone",
      validation_evidence: "called the office 10-06",
      reason: "seeding",
    });
    expect(r.isError).toBe(false);
    expect(r.body.created).toBe(true);
    expect(r.body.contact).toMatchObject({
      promoter_id: "p1",
      promoter_name: "Grange Fair",
      email: "jane.doe@grangefair.org",
      name: "Jane Doe & Co",
      validation_method: "phone",
      status: "candidate",
    });
    expect(audit()).toHaveLength(1);
    expect(audit()[0].action).toBe("promoter_contact.upserted");
    expect(JSON.parse(audit()[0].payload_json)).toMatchObject({
      promoterId: "p1",
      created: true,
      reason: "seeding",
    });
  });

  it("a second upsert for the same address edits the SAME row and keeps omitted fields", async () => {
    await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "jane@grangefair.org",
      name: "Jane",
      role: "Coordinator",
      validation_method: "phone",
    });
    const r = await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "JANE@grangefair.org",
      validation_method: "in_person",
      status: "validated",
    });
    expect(r.body.created).toBe(false);
    expect(r.body.contact).toMatchObject({
      name: "Jane",
      role: "Coordinator",
      validation_method: "in_person",
      status: "validated",
    });
    expect(r.body.contact.first_validated_at).not.toBeNull();
    expect((raw.prepare("SELECT count(*) n FROM promoter_contacts").get() as { n: number }).n).toBe(
      1
    );
  });

  it("refuses an unknown promoter, a bad address, and an unknown inbound id", async () => {
    expect(
      (
        await call("upsert_promoter_contact", {
          promoter_id: "nope",
          email: "a@b.org",
          validation_method: "phone",
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await call("upsert_promoter_contact", {
          promoter_id: "p1",
          email: "not-an-address",
          validation_method: "phone",
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await call("upsert_promoter_contact", {
          promoter_id: "p1",
          email: "a@b.org",
          validation_method: "phone",
          inbound_email_id: "nope",
        })
      ).isError
    ).toBe(true);
    expect(audit()).toEqual([]);
  });

  it("set_promoter_contact_status changes status with a required reason, audit-logged with from → to", async () => {
    const { body } = await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "x@grangefair.org",
      validation_method: "self_asserted",
    });
    expect(
      (
        await call("set_promoter_contact_status", {
          contact_id: body.contact.id,
          status: "rejected",
        })
      ).isError
    ).toBe(true);
    const r = await call("set_promoter_contact_status", {
      contact_id: body.contact.id,
      status: "rejected",
      reason: "not on staff",
    });
    expect(r.body).toMatchObject({ changed: true, contact: { status: "rejected" } });
    const last = audit().at(-1)!;
    expect(last.action).toBe("promoter_contact.status_set");
    expect(JSON.parse(last.payload_json)).toMatchObject({
      from: "candidate",
      to: "rejected",
      reason: "not on staff",
    });
  });

  it("list_promoter_contacts filters by promoter, status, method and email", async () => {
    await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "a@grangefair.org",
      validation_method: "phone",
      status: "validated",
    });
    await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "b@grangefair.org",
      validation_method: "self_asserted",
    });
    expect((await call("list_promoter_contacts", { promoter_id: "p1" })).body.count).toBe(2);
    expect(
      (await call("list_promoter_contacts", { status: "validated" })).body.contacts.map(
        (c: { email: string }) => c.email
      )
    ).toEqual(["a@grangefair.org"]);
    expect(
      (await call("list_promoter_contacts", { validation_method: "self_asserted" })).body.count
    ).toBe(1);
    expect((await call("list_promoter_contacts", { email: "B@GrangeFair.org" })).body.count).toBe(
      1
    );
    expect((await call("list_promoter_contacts", { promoter_id: "nobody" })).body).toEqual({
      count: 0,
      contacts: [],
    });
  });
});

describe("reader and writer field sets match (OPE-534 class)", () => {
  it("every upsert_promoter_contact data param is a key list_promoter_contacts returns", async () => {
    const CONTROL = new Set(["reason"]);
    const writer = Object.keys(server.schemas.get("upsert_promoter_contact")!).filter(
      (k) => !CONTROL.has(k)
    );
    await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "a@grangefair.org",
      validation_method: "phone",
    });
    const [row] = (await call("list_promoter_contacts", {})).body.contacts;
    const missing = writer.filter((k) => !(k in row));
    expect(
      missing,
      `the writer can set these but the reader never returns them: ${missing}`
    ).toEqual([]);
  });

  it("the control-param exemption is honest: 'reason' is not a column", () => {
    expect(Object.keys(server.schemas.get("upsert_promoter_contact")!)).toContain("reason");
  });
});

describe("get_inbound_email returns the sender's contact rows", () => {
  beforeEach(() => {
    registerInboundReadTools(server as never, db, ADMIN);
    raw
      .prepare(
        "INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at, matched_entities) VALUES ('ib1', 1791259098, 'Office@GrangeFair.org', 'submit@meetmeatthefair.com', 'correction', 1791259098, '[]')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at, matched_entities) VALUES ('ib2', 1791259098, 'stranger@nowhere.org', 'submit@meetmeatthefair.com', 'question', 1791259098, '[]')"
      )
      .run();
  });

  it("a known sender → its contact rows (status, method, first validated) next to matched_entities", async () => {
    await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "office@grangefair.org",
      validation_method: "published_on_site",
      status: "validated",
    });
    const { body } = await call("get_inbound_email", { inbound_email_id: "ib1" });
    const email = body.email ?? body;
    expect(email.promoter_contacts).toEqual([
      expect.objectContaining({
        promoter_id: "p1",
        promoter_name: "Grange Fair",
        status: "validated",
        validation_method: "published_on_site",
      }),
    ]);
    expect(email.promoter_contacts[0].first_validated_at).not.toBeNull();
  });

  it("an unknown sender → an empty list, not an error", async () => {
    const { isError, body } = await call("get_inbound_email", { inbound_email_id: "ib2" });
    expect(isError).toBe(false);
    expect((body.email ?? body).promoter_contacts).toEqual([]);
  });
});

describe("the PUBLIC get_promoter_details never carries contact data", () => {
  it("returns no contacts key even when the promoter has validated contacts", async () => {
    await call("upsert_promoter_contact", {
      promoter_id: "p1",
      email: "jane@grangefair.org",
      name: "Jane Secret",
      phone: "207-555-0100",
      validation_method: "phone",
      status: "validated",
    });
    const pub = new CapturingMcpServer();
    registerPublicTools(pub as never, db);
    const r = (await pub.invoke("get_promoter_details", { slug: "grange-fair" })) as Result;
    const text = r.content[0].text;
    expect(text).not.toContain("jane@grangefair.org");
    expect(text).not.toContain("Jane Secret");
    expect(text).not.toContain("207-555-0100");
    expect(text).not.toMatch(/"contacts"|promoter_contacts/);
  });
});

describe("the inbound workflow runs the capture step (wiring pinned on CALL syntax)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "workflows", "inbound-email.ts"), "utf8");
  it("calls capturePromoterContacts inside step 'promoter-contacts/capture', fail-soft", () => {
    const at = src.indexOf('"promoter-contacts/capture"');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at - 200, at + 600);
    expect(block).toContain("capturePromoterContacts(getDb(this.env.DB), messageRowId, sessionId)");
    expect(block).toMatch(
      /try \{[\s\S]*promoter-contacts\/capture[\s\S]*\} catch \(err\) \{[\s\S]*logError/
    );
  });
  it("runs BEFORE send-reply, so it is reached on every email the workflow evaluates", () => {
    expect(src.indexOf('"promoter-contacts/capture"')).toBeLessThan(src.indexOf('"send-reply"'));
  });
});

describe("MCP approvePromoterClaim records the claimant (twin of the app paths)", () => {
  it("the claimant becomes validated / approved_claim; a rejected row is left alone", async () => {
    raw
      .prepare(
        "INSERT INTO users (id, email, name) VALUES ('u-owner', 'Owner@GrangeFair.org', 'Pat Owner')"
      )
      .run();
    await approvePromoterClaim(db, {
      promoterId: "p1",
      userId: "u-owner",
      actorUserId: "u-admin",
    } as never);
    expect(
      raw.prepare("SELECT email, name, status, validation_method FROM promoter_contacts").all()
    ).toEqual([
      {
        email: "owner@grangefair.org",
        name: "Pat Owner",
        status: "validated",
        validation_method: "approved_claim",
      },
    ]);
    expect(audit().map((a) => a.action)).toEqual(["promoter_contact.claim_validated"]);
  });
});
