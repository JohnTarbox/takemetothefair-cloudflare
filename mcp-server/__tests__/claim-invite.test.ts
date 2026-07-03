/**
 * OPE-67 — create_claim_invite (cold-contact claim invite).
 *
 * In-memory SQLite harness with a capturing EMAIL_JOBS mock. Asserts:
 *   - validates the entity is unclaimed
 *   - suppression → no-op (suppressed:true), nothing sent, nothing minted
 *   - idempotent: an unexpired invite for the same (entity, email) is a no-op
 *   - mint writes a cold-invite claim_tokens row (userId NULL, email set)
 *   - NO entity_claims row is written at invite time
 *   - the raw token never appears in the tool result (only in the email)
 *   - vendors get a vendor_outreach_attempts touch; promoters don't
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerCreateClaimInviteTool } from "../src/tools/admin-claim-invite.js";
import {
  vendors,
  promoters,
  claimTokens,
  entityClaims,
  emailSuppressionList,
  vendorOutreachAttempts,
  adminActions,
} from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;
let sent: Array<Record<string, unknown>>;
let env: Record<string, unknown>;

function seedVendor(over: Partial<typeof vendors.$inferInsert> = {}) {
  const id = over.id ?? "v-1";
  db.insert(vendors)
    .values({
      id,
      userId: over.userId ?? `user-${id}`,
      businessName: over.businessName ?? "Acme Crafts",
      slug: over.slug ?? "acme-crafts",
      contactEmail: over.contactEmail ?? "owner@acme.test",
      claimed: over.claimed ?? false,
      ...over,
    })
    .run();
  return id;
}

function seedPromoter(over: Partial<typeof promoters.$inferInsert> = {}) {
  const id = over.id ?? "p-1";
  db.insert(promoters)
    .values({
      id,
      companyName: over.companyName ?? "Fair Org",
      slug: over.slug ?? "fair-org",
      contactEmail: over.contactEmail ?? "org@fair.test",
      claimed: over.claimed ?? false,
      ...over,
    })
    .run();
  return id;
}

async function invoke(name: string, params: Record<string, unknown>) {
  const res = (await server.invoke(name, params)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { res, json: JSON.parse(res.content[0].text) as Record<string, unknown> };
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  sent = [];
  env = {
    EMAIL_JOBS: { send: async (m: Record<string, unknown>) => void sent.push(m) },
    INTERNAL_API_KEY: "test-secret",
  };
  registerCreateClaimInviteTool(server as never, db, ADMIN_AUTH, env as never);
});

describe("create_claim_invite (OPE-67)", () => {
  it("mints a cold-invite token and sends the invite email (vendor)", async () => {
    seedVendor({ contactEmail: "owner@acme.test" });
    const { json } = await invoke("create_claim_invite", {
      entity_type: "VENDOR",
      entity_id: "v-1",
    });

    expect(json.created).toBe(true);
    expect(json.email).toBe("owner@acme.test");
    expect(json.entityType).toBe("VENDOR");

    // Cold-invite token row: userId NULL, email set, unexpired.
    const rows = await db.select().from(claimTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].email).toBe("owner@acme.test");
    expect(rows[0].entityType).toBe("VENDOR");
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

    // NO entity_claims row at invite time (deferred to redemption).
    expect(await db.select().from(entityClaims)).toHaveLength(0);

    // primary + BCC emails.
    expect(sent).toHaveLength(2);
    const primary = sent[0] as { to: string; text: string; html: string };
    expect(primary.to).toBe("owner@acme.test");
    // Magic link with the invite param present in the email body.
    expect(primary.text).toContain("/register?role=VENDOR&claim=acme-crafts&invite=");
    // Unsubscribe footer from applyCanSpamFooter.
    expect(primary.text.toLowerCase()).toContain("unsubscribe");

    // Raw token is emailed but NEVER returned in the tool result.
    const linkMatch = primary.text.match(/invite=([a-f0-9]+)/);
    expect(linkMatch).not.toBeNull();
    const rawToken = linkMatch![1];
    expect(JSON.stringify(json)).not.toContain(rawToken);

    // Vendor outreach attempt recorded.
    const attempts = await db.select().from(vendorOutreachAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].notes).toBe("create_claim_invite");
    expect(attempts[0].outcome).toBe("sent");

    // Audit row.
    const actions = await db.select().from(adminActions);
    expect(actions.some((a) => a.action === "vendor.claim_invite_sent")).toBe(true);
  });

  it("uses contact email by default and honors an email override", async () => {
    seedVendor({ contactEmail: "default@acme.test" });
    const { json } = await invoke("create_claim_invite", {
      entity_type: "VENDOR",
      entity_id: "v-1",
      email: "Override@Acme.Test",
    });
    expect(json.created).toBe(true);
    expect(json.email).toBe("override@acme.test"); // lowercased
  });

  it("promoters get an invite but NO outreach attempt row", async () => {
    seedPromoter({ contactEmail: "org@fair.test" });
    const { json } = await invoke("create_claim_invite", {
      entity_type: "PROMOTER",
      entity_id: "p-1",
    });
    expect(json.created).toBe(true);
    expect(sent).toHaveLength(2);
    const primary = sent[0] as { text: string };
    expect(primary.text).toContain("/register?role=PROMOTER&claim=fair-org&invite=");
    expect(await db.select().from(vendorOutreachAttempts)).toHaveLength(0);
  });

  it("refuses an already-claimed entity", async () => {
    seedVendor({ claimed: true, contactEmail: "owner@acme.test" });
    const { res, json } = await invoke("create_claim_invite", {
      entity_type: "VENDOR",
      entity_id: "v-1",
    });
    expect(res.isError).toBe(true);
    expect(json.error).toBe("already_claimed");
    expect(sent).toHaveLength(0);
    expect(await db.select().from(claimTokens)).toHaveLength(0);
  });

  it("errors when there is no email to send to", async () => {
    seedVendor({ contactEmail: null });
    const { res, json } = await invoke("create_claim_invite", {
      entity_type: "VENDOR",
      entity_id: "v-1",
    });
    expect(res.isError).toBe(true);
    expect(json.error).toBe("no_email");
    expect(sent).toHaveLength(0);
  });

  it("suppressed recipient → no-op, nothing sent or minted", async () => {
    seedVendor({ contactEmail: "owner@acme.test" });
    db.insert(emailSuppressionList)
      .values({ email: "owner@acme.test", reason: "unsub", source: "test", createdAt: new Date() })
      .run();

    const { json } = await invoke("create_claim_invite", {
      entity_type: "VENDOR",
      entity_id: "v-1",
    });
    expect(json.suppressed).toBe(true);
    expect(json.created).toBe(false);
    expect(sent).toHaveLength(0);
    expect(await db.select().from(claimTokens)).toHaveLength(0);
  });

  it("is idempotent — a second call while an invite is active is a no-op", async () => {
    seedVendor({ contactEmail: "owner@acme.test" });
    const first = await invoke("create_claim_invite", { entity_type: "VENDOR", entity_id: "v-1" });
    expect(first.json.created).toBe(true);

    const second = await invoke("create_claim_invite", { entity_type: "VENDOR", entity_id: "v-1" });
    expect(second.json.created).toBe(false);
    expect(second.json.reason).toBe("active_invite_exists");

    // Still only ONE token, and only the first send happened (2 messages total).
    expect(await db.select().from(claimTokens)).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("re-mints once the prior invite has expired", async () => {
    seedVendor({ contactEmail: "owner@acme.test" });
    // Seed an already-expired token for the same (entity, email).
    db.insert(claimTokens)
      .values({
        id: "expired-1",
        entityType: "VENDOR",
        entityId: "v-1",
        userId: null,
        email: "owner@acme.test",
        tokenHash: "deadbeef",
        createdAt: new Date(Date.now() - 20 * 24 * 3600 * 1000),
        expiresAt: new Date(Date.now() - 6 * 24 * 3600 * 1000),
      })
      .run();

    const { json } = await invoke("create_claim_invite", {
      entity_type: "VENDOR",
      entity_id: "v-1",
    });
    expect(json.created).toBe(true);

    // Expired one swept, exactly one fresh unexpired token remains.
    const rows = await db.select().from(claimTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe("expired-1");
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("errors for a missing entity", async () => {
    const { res, json } = await invoke("create_claim_invite", {
      entity_type: "VENDOR",
      entity_id: "nope",
    });
    expect(res.isError).toBe(true);
    expect(json.error).toBe("entity_not_found");
  });
});

describe("create_claim_invite — non-admin", () => {
  it("does not register the tool for non-admin auth", () => {
    const s = new CapturingMcpServer();
    registerCreateClaimInviteTool(
      s as never,
      db,
      { userId: "u", role: "USER" } as never,
      env as never
    );
    expect(s.handlers.has("create_claim_invite")).toBe(false);
  });
});
