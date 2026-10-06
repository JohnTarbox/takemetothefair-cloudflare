/**
 * OPE-1330 — admin tools for `promoter_contacts`: the named people at a
 * promoter who have actually corresponded with us, and how each was validated.
 *
 *   list_promoter_contacts       read, filterable
 *   upsert_promoter_contact      create or edit one (by promoter + email)
 *   set_promoter_contact_status  candidate / validated / stale / rejected
 *
 * Every write is audit-logged in `admin_actions`. ⚠️ Personal contact data:
 * ADMIN ONLY (the registrar returns for anyone else), and none of it is ever
 * copied into `promoters.contact_email`, which is public.
 *
 * The write rule is the shared `planPromoterContactWrite` — the same one the
 * inbound capture and the claim-approval paths use.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  PROMOTER_CONTACT_STATUSES,
  PROMOTER_CONTACT_VALIDATION_METHODS,
  normalizeEmailAddress,
  planPromoterContactWrite,
} from "@takemetothefair/db-schema";
import { adminActions, inboundEmails, promoterContacts, promoters } from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** One contact row as every reader returns it (snake_case, the writer's names). */
export function presentPromoterContact(
  c: typeof promoterContacts.$inferSelect,
  promoter?: { companyName: string | null; slug: string | null } | null
) {
  return {
    id: c.id,
    promoter_id: c.promoterId,
    promoter_name: promoter?.companyName ?? null,
    promoter_slug: promoter?.slug ?? null,
    name: c.name,
    role: c.role,
    email: c.email,
    phone: c.phone,
    validation_method: c.validationMethod,
    validation_evidence: c.validationEvidence,
    inbound_email_id: c.inboundEmailId,
    sender_auth: c.senderAuth,
    auth_domain: c.authDomain,
    auth_domain_matches_promoter: c.authDomainMatchesPromoter,
    status: c.status,
    first_validated_at: iso(c.firstValidatedAt),
    last_heard_at: iso(c.lastHeardAt),
    notes: c.notes,
    created_by: c.createdBy,
    updated_by: c.updatedBy,
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
  };
}

const freeText = (max: number) => z.string().max(max).transform(decodeHtmlEntities);

export function registerPromoterContactTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;
  const actor = auth.userId ?? "admin";

  server.tool(
    "list_promoter_contacts",
    [
      "OPE-1330 — the named people (or team mailboxes) at a promoter who have actually corresponded with us,",
      "with how each was validated. Admin only: personal contact data, never public.",
      "Rows are captured automatically from inbound mail (status 'candidate', or 'validated' when DMARC passed",
      "aligned to the promoter's own website domain) and from approved promoter claims; admins edit them with",
      "upsert_promoter_contact / set_promoter_contact_status. 'validated' via domain_verified proves the mail",
      "came from the promoter's domain — not the person's name or role.",
    ].join(" "),
    {
      promoter_id: z.string().min(1).optional().describe("Only this promoter's contacts."),
      status: z.enum(PROMOTER_CONTACT_STATUSES).optional(),
      validation_method: z.enum(PROMOTER_CONTACT_VALIDATION_METHODS).optional(),
      email: z.string().max(320).optional().describe("Exact address (case-insensitive)."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
    },
    async (params) => {
      const where: SQL[] = [];
      if (params.promoter_id) where.push(eq(promoterContacts.promoterId, params.promoter_id));
      if (params.status) where.push(eq(promoterContacts.status, params.status));
      if (params.validation_method)
        where.push(eq(promoterContacts.validationMethod, params.validation_method));
      if (params.email) {
        const e = normalizeEmailAddress(params.email);
        if (!e)
          return {
            content: [jsonContent({ error: "email is not a valid address" })],
            isError: true,
          };
        where.push(eq(promoterContacts.email, e));
      }
      const rows = await db
        .select({ c: promoterContacts, companyName: promoters.companyName, slug: promoters.slug })
        .from(promoterContacts)
        .leftJoin(promoters, eq(promoters.id, promoterContacts.promoterId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(promoterContacts.updatedAt))
        .limit(params.limit ?? 50);
      return {
        content: [
          jsonContent({
            count: rows.length,
            contacts: rows.map((r) =>
              presentPromoterContact(r.c, { companyName: r.companyName, slug: r.slug })
            ),
          }),
        ],
      };
    }
  );

  server.tool(
    "upsert_promoter_contact",
    [
      "OPE-1330 — create or edit a promoter contact, keyed by (promoter_id, email). Admin only; audit-logged.",
      "Use it to seed contacts you have validated by other means (phone, in person, published on the",
      "promoter's site) or to correct a captured row. Fields you omit on an existing row are left as they are.",
      "Never writes promoters.contact_email.",
    ].join(" "),
    {
      promoter_id: z.string().min(1),
      email: z.string().min(3).max(320),
      name: freeText(200).nullable().optional(),
      role: freeText(200).nullable().optional(),
      phone: z.string().max(50).nullable().optional(),
      validation_method: z.enum(PROMOTER_CONTACT_VALIDATION_METHODS),
      validation_evidence: freeText(2000).nullable().optional(),
      inbound_email_id: z.string().min(1).nullable().optional(),
      status: z
        .enum(PROMOTER_CONTACT_STATUSES)
        .optional()
        .describe(
          "Default 'candidate' for a new row; an existing row keeps its status when omitted."
        ),
      notes: freeText(2000).nullable().optional(),
      reason: z.string().max(500).optional().describe("Why — recorded in admin_actions."),
    },
    async (params) => {
      const email = normalizeEmailAddress(params.email);
      if (!email)
        return { content: [jsonContent({ error: "email is not a valid address" })], isError: true };
      const [promoter] = await db
        .select({ id: promoters.id, companyName: promoters.companyName, slug: promoters.slug })
        .from(promoters)
        .where(eq(promoters.id, params.promoter_id))
        .limit(1);
      if (!promoter)
        return { content: [jsonContent({ error: "promoter not found" })], isError: true };
      if (params.inbound_email_id) {
        const [ib] = await db
          .select({ id: inboundEmails.id })
          .from(inboundEmails)
          .where(eq(inboundEmails.id, params.inbound_email_id))
          .limit(1);
        if (!ib)
          return { content: [jsonContent({ error: "inbound_email_id not found" })], isError: true };
      }
      const [existing] = await db
        .select()
        .from(promoterContacts)
        .where(and(eq(promoterContacts.promoterId, promoter.id), eq(promoterContacts.email, email)))
        .limit(1);

      const now = new Date();
      const plan = planPromoterContactWrite({
        writer: "manual",
        existing: existing ?? null,
        promoterId: promoter.id,
        email,
        fields: {
          name: params.name,
          role: params.role,
          phone: params.phone,
          validationMethod: params.validation_method,
          validationEvidence: params.validation_evidence,
          inboundEmailId: params.inbound_email_id,
          notes: params.notes,
          status: params.status ?? existing?.status ?? "candidate",
        },
        actor,
        now,
      });
      if (plan.kind === "invalid")
        return { content: [jsonContent({ error: plan.reason })], isError: true };

      let id: string;
      if (plan.kind === "insert") {
        id = crypto.randomUUID();
        await db
          .insert(promoterContacts)
          .values({ id, ...(plan.values as typeof promoterContacts.$inferInsert) });
      } else {
        id = plan.id;
        if (plan.kind === "update")
          await db.update(promoterContacts).set(plan.set).where(eq(promoterContacts.id, id));
      }
      await db.insert(adminActions).values({
        action: "promoter_contact.upserted",
        actorUserId: auth.userId ?? null,
        targetType: "promoter_contact",
        targetId: id,
        payloadJson: JSON.stringify({
          promoterId: promoter.id,
          created: plan.kind === "insert",
          fields: Object.keys(params).filter(
            (k) => k !== "reason" && params[k as keyof typeof params] !== undefined
          ),
          reason: params.reason ?? null,
        }),
        createdAt: now,
      });
      const [row] = await db
        .select()
        .from(promoterContacts)
        .where(eq(promoterContacts.id, id))
        .limit(1);
      return {
        content: [
          jsonContent({
            created: plan.kind === "insert",
            contact: presentPromoterContact(row, promoter),
          }),
        ],
      };
    }
  );

  server.tool(
    "set_promoter_contact_status",
    [
      "OPE-1330 — move a promoter contact to candidate / validated / stale / rejected. Admin only; audit-logged",
      "with the reason. 'rejected' is permanent against automation: inbound capture never re-promotes it.",
    ].join(" "),
    {
      contact_id: z.string().min(1),
      status: z.enum(PROMOTER_CONTACT_STATUSES),
      reason: z.string().min(1).max(500).describe("Why — recorded in admin_actions."),
    },
    async (params) => {
      const [c] = await db
        .select()
        .from(promoterContacts)
        .where(eq(promoterContacts.id, params.contact_id))
        .limit(1);
      if (!c) return { content: [jsonContent({ error: "contact not found" })], isError: true };
      const now = new Date();
      if (c.status !== params.status) {
        await db
          .update(promoterContacts)
          .set({
            status: params.status,
            ...(params.status === "validated" && !c.firstValidatedAt
              ? { firstValidatedAt: now }
              : {}),
            updatedBy: actor,
            updatedAt: now,
          })
          .where(eq(promoterContacts.id, c.id));
        await db.insert(adminActions).values({
          action: "promoter_contact.status_set",
          actorUserId: auth.userId ?? null,
          targetType: "promoter_contact",
          targetId: c.id,
          payloadJson: JSON.stringify({
            promoterId: c.promoterId,
            from: c.status,
            to: params.status,
            reason: params.reason,
          }),
          createdAt: now,
        });
      }
      const [row] = await db
        .select()
        .from(promoterContacts)
        .where(eq(promoterContacts.id, c.id))
        .limit(1);
      return {
        content: [
          jsonContent({
            changed: c.status !== params.status,
            contact: presentPromoterContact(row),
          }),
        ],
      };
    }
  );
}
