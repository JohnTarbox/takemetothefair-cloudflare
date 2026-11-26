/**
 * OPE-1614 — operator handles on an organization's domain list.
 *
 * list_org_domains · add_org_domain · retire_org_domain ·
 * review_org_domain_candidate · discover_org_domains · set_shared_org_domain
 *
 * Every write goes through the shared core in @takemetothefair/db-schema
 * (org-domains.ts), which applies the "what may add a domain" rules and
 * audit-logs to admin_actions. Admin only. Nothing here sends mail.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import {
  addOrgDomain,
  matchableDomainsFor,
  ORG_DOMAIN_ENTITY_TYPES,
  orgDomainList,
  orgsForDomain,
  retireOrgDomain,
  setSharedOrgDomain,
  ownableOrgDomain,
} from "@takemetothefair/db-schema";
import { inboundEmails, orgDomains, promoters, vendors, venues } from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";
import { discoverOrgDomains } from "../inbound/org-domain-discovery.js";

const entityType = z.enum(ORG_DOMAIN_ENTITY_TYPES);
const reasonText = z.string().max(500).transform(decodeHtmlEntities).optional();
const err = (error: string) => ({ content: [jsonContent({ error })], isError: true as const });

async function entityExists(db: Db, type: (typeof ORG_DOMAIN_ENTITY_TYPES)[number], id: string) {
  const t = type === "promoter" ? promoters : type === "vendor" ? vendors : venues;
  const [row] = await db.select({ id: t.id }).from(t).where(eq(t.id, id)).limit(1);
  return !!row;
}

export function registerOrgDomainTools(server: McpServer, db: Db, auth: AuthContext) {
  const actor = `operator:${auth.userId}`;

  server.tool(
    "list_org_domains",
    [
      "OPE-1614 — an organization's domain list: its website host (method 'website', implicit) plus every",
      "domain established for it, each with status (active / candidate / retired), how it was established and",
      "the evidence. Each domain also reports whether it is SHARED (on more than one org of the same type, or",
      "operator-listed) — a shared domain never auto-attaches contacts, claims or verdicts. Admin only.",
    ].join(" "),
    { entity_type: entityType, entity_id: z.string().min(1) },
    async (p) => {
      if (!(await entityExists(db, p.entity_type, p.entity_id)))
        return err(`${p.entity_type} not found`);
      const list = await orgDomainList(db, p.entity_type, p.entity_id);
      const out = [];
      for (const e of list) {
        const owners = await orgsForDomain(db, p.entity_type, e.domain);
        out.push({
          domain: e.domain,
          status: e.status,
          method: e.method,
          evidence: e.evidence,
          source_url: e.sourceUrl,
          inbound_email_id: e.inboundEmailId,
          added_by: e.addedBy,
          created_at: e.createdAt ? e.createdAt.toISOString() : null,
          shared: owners.shared,
          shared_with: owners.shared ? owners.allOwners.filter((id) => id !== p.entity_id) : [],
        });
      }
      return {
        content: [
          jsonContent({
            entity_type: p.entity_type,
            entity_id: p.entity_id,
            matchable: await matchableDomainsFor(db, p.entity_type, p.entity_id),
            domains: out,
          }),
        ],
      };
    }
  );

  server.tool(
    "add_org_domain",
    [
      "OPE-1614 — add a domain to an organization's list. Audit-logged. method 'operator' (default) adds it",
      "active. method 'contact_claim' records a validated contact saying \"we also use X\": it needs the",
      "inbound_email_id of their message, which must have passed DMARC from a domain already on this org's",
      "list, and it only ever creates a CANDIDATE (promote it with review_org_domain_candidate). Free-mail and",
      "shared hosts (gmail.com, facebook.com, …) are always refused. An operator add re-activates a retired row.",
    ].join(" "),
    {
      entity_type: entityType,
      entity_id: z.string().min(1),
      domain: z.string().min(3).max(253),
      method: z.enum(["operator", "contact_claim"]).optional(),
      inbound_email_id: z.string().min(1).optional(),
      evidence: z.string().max(2000).transform(decodeHtmlEntities).optional(),
    },
    async (p) => {
      if (!(await entityExists(db, p.entity_type, p.entity_id)))
        return err(`${p.entity_type} not found`);
      const method = p.method ?? "operator";
      let senderValidated = false;
      if (method === "contact_claim") {
        if (!p.inbound_email_id) return err("contact_claim needs inbound_email_id");
        const [ib] = await db
          .select({ from: inboundEmails.fromAddress, dmarc: inboundEmails.dmarcResult })
          .from(inboundEmails)
          .where(eq(inboundEmails.id, p.inbound_email_id))
          .limit(1);
        if (!ib) return err("inbound_email_id not found");
        const senderOrg = ownableOrgDomain(ib.from);
        const own = await matchableDomainsFor(db, p.entity_type, p.entity_id);
        senderValidated =
          (ib.dmarc ?? "").toLowerCase() === "pass" && !!senderOrg && own.includes(senderOrg);
      }
      const res = await addOrgDomain(db, {
        entityType: p.entity_type,
        entityId: p.entity_id,
        domain: p.domain,
        method,
        senderValidated,
        evidence: p.evidence ?? null,
        inboundEmailId: p.inbound_email_id ?? null,
        actor,
        actorUserId: auth.userId ?? null,
      });
      if (!res.ok) return err(res.reason);
      return { content: [jsonContent(res)] };
    }
  );

  server.tool(
    "retire_org_domain",
    [
      "OPE-1614 — retire a domain from an organization's list (including its website host, which is otherwise",
      "an implicit member). A retired domain no longer matches anything for that org, and automation never",
      "re-adds it; only add_org_domain by an operator does. Audit-logged with the reason.",
    ].join(" "),
    {
      entity_type: entityType,
      entity_id: z.string().min(1),
      domain: z.string().min(3).max(253),
      reason: reasonText,
    },
    async (p) => {
      const res = await retireOrgDomain(db, {
        entityType: p.entity_type,
        entityId: p.entity_id,
        domain: p.domain,
        actor,
        actorUserId: auth.userId ?? null,
        reason: p.reason ?? null,
      });
      if (!res.ok) return err(res.reason);
      return { content: [jsonContent(res)] };
    }
  );

  server.tool(
    "review_org_domain_candidate",
    "OPE-1614 — promote a CANDIDATE domain to active, or reject it (retired). Audit-logged.",
    {
      id: z.string().min(1).describe("org_domains row id (from list_org_domains)."),
      decision: z.enum(["promote", "reject"]),
      reason: reasonText,
    },
    async (p) => {
      const [row] = await db.select().from(orgDomains).where(eq(orgDomains.id, p.id)).limit(1);
      if (!row) return err("org_domains row not found");
      if (row.status !== "candidate") return err(`row is ${row.status}, not candidate`);
      const res =
        p.decision === "promote"
          ? await addOrgDomain(db, {
              entityType: row.entityType,
              entityId: row.entityId,
              domain: row.domain,
              method: "operator",
              evidence: `promoted candidate (${row.method}: ${row.evidence ?? ""})${p.reason ? `; ${p.reason}` : ""}`,
              actor,
              actorUserId: auth.userId ?? null,
            })
          : await retireOrgDomain(db, {
              entityType: row.entityType,
              entityId: row.entityId,
              domain: row.domain,
              actor,
              actorUserId: auth.userId ?? null,
              reason: p.reason ?? "candidate rejected",
            });
      if (!res.ok) return err(res.reason);
      return { content: [jsonContent(res)] };
    }
  );

  server.tool(
    "discover_org_domains",
    [
      "OPE-1614 — gather the evidence that adds domains automatically, for one organization: reads its own",
      "site (homepage and /contact on each active domain) and adds every ownable domain it publishes an email",
      "address on ('site_published_email'); then redirect-checks each candidate domain you pass and adds it",
      "when https://<domain>/ redirects to a domain on exactly one org's list ('website_redirect', the chain is",
      "the evidence). Fetches only https://<registrable domain>/… pages. Sends nothing. Audit-logged.",
    ].join(" "),
    {
      entity_type: entityType,
      entity_id: z.string().min(1),
      candidate_domains: z.array(z.string().min(3).max(253)).max(10).optional(),
    },
    async (p) => {
      if (!(await entityExists(db, p.entity_type, p.entity_id)))
        return err(`${p.entity_type} not found`);
      const res = await discoverOrgDomains(db, p.entity_type, p.entity_id, (u, i) => fetch(u, i), {
        candidates: p.candidate_domains,
      });
      return { content: [jsonContent(res)] };
    }
  );

  server.tool(
    "set_shared_org_domain",
    [
      "OPE-1614 — mark (or unmark) an umbrella domain that many organizations share — a town's departments on",
      "one town.gov, Grange chapters on a state Grange domain. A shared domain never auto-attaches anything:",
      "contacts from it stay pending until an operator picks the org. Audit-logged.",
    ].join(" "),
    {
      domain: z.string().min(3).max(253),
      shared: z.boolean(),
      note: z.string().max(500).transform(decodeHtmlEntities).optional(),
    },
    async (p) => {
      const res = await setSharedOrgDomain(db, {
        domain: p.domain,
        shared: p.shared,
        note: p.note ?? null,
        actor,
        actorUserId: auth.userId ?? null,
      });
      if (!res.ok) return err(res.reason);
      return { content: [jsonContent(res)] };
    }
  );
}
