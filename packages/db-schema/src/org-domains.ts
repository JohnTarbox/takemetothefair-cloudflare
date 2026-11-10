/**
 * OPE-1614 — an organization can have several domains.
 *
 * Every domain match used to assume one domain per org: the host of its
 * `website` field. OHTM emails from ohtm.org while its website is
 * owlshead.org (ohtm.org 302-redirects there), so the validated-contact
 * rule, the pending-contact attach and the claim wizard could never tie the
 * two together.
 *
 * This module is the ONE reader of an org's domain list, imported by both
 * deploy artifacts, so the claim wizard (main app) and inbound capture (MCP)
 * cannot drift apart.
 *
 * The list for an org is:
 *   - the registrable domain of its `website` — an IMPLICIT active member,
 *     computed at read time so it never drifts from the field (the "seed");
 *   - plus its `org_domains` rows with status `active`;
 *   - minus any domain with a `retired` row for that org (which also
 *     withdraws the implicit website member).
 *
 * A domain is SHARED when it is on the active list of more than one org of
 * the same type, or an operator listed it in `shared_org_domains`. A shared
 * domain never auto-attaches anything: `matchableDomainsFor` leaves it out,
 * and `orgsForDomain` returns no owner for it.
 *
 * Free-mail, mailbox-provider and shared-host domains (`isNonOwnableDomain`)
 * can never be on a list: `planOrgDomainAdd` refuses them, and the readers
 * drop them even if one got into the table by hand.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { isNonOwnableDomain, organizationalDomain } from "@takemetothefair/utils";
import * as schema from "./index";
import { adminActions, orgDomains, promoters, sharedOrgDomains, vendors, venues } from "./index";

type Db = DrizzleD1Database<typeof schema>;

export const ORG_DOMAIN_ENTITY_TYPES = ["promoter", "vendor", "venue"] as const;
export type OrgDomainEntityType = (typeof ORG_DOMAIN_ENTITY_TYPES)[number];

export const ORG_DOMAIN_METHODS = [
  "website",
  "website_redirect",
  "site_published_email",
  "operator",
  "contact_claim",
] as const;
export type OrgDomainMethod = (typeof ORG_DOMAIN_METHODS)[number];

/** Methods that may ADD a domain. `website` is the implicit seed, never written. */
export type OrgDomainAddMethod = Exclude<OrgDomainMethod, "website">;

/**
 * The registrable domain of an address / host / URL, or null when it is
 * unparseable or nobody can own it (free-mail, shared host, a bare public
 * suffix — tldts returns null for `co.uk`).
 */
export function ownableOrgDomain(value: string | null | undefined): string | null {
  const d = organizationalDomain(value);
  if (!d || isNonOwnableDomain(d)) return null;
  return d;
}

/**
 * What an add with this evidence may do (the ticket's §2 table).
 *
 *   website_redirect, site_published_email, operator → active
 *   contact_claim ("a validated contact says we also use X") → candidate
 *   anything from an unvalidated sender → refused
 *   a non-ownable domain → refused, whatever the method
 */
export function planOrgDomainAdd(input: {
  method: OrgDomainAddMethod;
  domain: string | null | undefined;
  /** Required true for `contact_claim`: the claimant's own mail passed DMARC. */
  senderValidated?: boolean;
}): { ok: true; domain: string; status: "active" | "candidate" } | { ok: false; reason: string } {
  const raw = (input.domain ?? "").trim().toLowerCase();
  const domain = organizationalDomain(raw);
  if (!domain) return { ok: false, reason: `${raw || "(empty)"} is not a registrable domain` };
  if (isNonOwnableDomain(domain))
    return { ok: false, reason: `${domain} is a free-mail or shared domain; nobody owns it` };
  switch (input.method) {
    case "website_redirect":
    case "site_published_email":
    case "operator":
      return { ok: true, domain, status: "active" };
    case "contact_claim":
      if (!input.senderValidated)
        return { ok: false, reason: "an unvalidated sender's claim adds nothing" };
      // Their message proves their CURRENT domain, not the one they name.
      return { ok: true, domain, status: "candidate" };
  }
}

// A function, not a module-level const: index.ts re-exports this file, so at
// this module's evaluation the tables are not defined yet (circular import).
const tableFor = (type: OrgDomainEntityType) =>
  type === "promoter" ? promoters : type === "vendor" ? vendors : venues;

/** Rows of one type whose website names this domain (prefilter + exact org-domain check). */
async function websiteOwners(db: Db, type: OrgDomainEntityType, domain: string): Promise<string[]> {
  const t = tableFor(type);
  // instr, not LIKE: D1 throws on a LIKE pattern over 50 chars. A prefilter
  // only — the registrable-domain equality below is the match.
  const where = [sql`instr(lower(${t.website}), ${domain}) > 0`];
  if (type === "vendor") where.push(isNull(vendors.deletedAt));
  const rows = await db
    .select({ id: t.id, website: t.website })
    .from(t)
    .where(and(...where))
    .limit(200);
  return rows.filter((r) => organizationalDomain(r.website) === domain).map((r) => r.id);
}

export interface DomainOwners {
  /** The ONE owner when the domain is unshared; empty otherwise. */
  ids: string[];
  /** Every org of this type with the domain on its active list. */
  allOwners: string[];
  shared: boolean;
  reason: string;
}

/**
 * Which org of `type` owns this domain? Exactly one owner, or none.
 * More than one (or an operator-listed umbrella domain) is SHARED: no owner
 * is returned, so nothing attaches by domain alone.
 */
export async function orgsForDomain(
  db: Db,
  type: OrgDomainEntityType,
  value: string | null | undefined
): Promise<DomainOwners> {
  const none = (reason: string, shared = false, allOwners: string[] = []): DomainOwners => ({
    ids: [],
    allOwners,
    shared,
    reason,
  });
  const org = organizationalDomain(value);
  if (!org) return none("no parseable domain");
  if (isNonOwnableDomain(org)) return none(`${org} is a shared or free-mail domain`);

  const rows = await db
    .select({ entityId: orgDomains.entityId, status: orgDomains.status })
    .from(orgDomains)
    .where(and(eq(orgDomains.entityType, type), eq(orgDomains.domain, org)));
  const retired = new Set(rows.filter((r) => r.status === "retired").map((r) => r.entityId));
  const owners = new Set(rows.filter((r) => r.status === "active").map((r) => r.entityId));
  for (const id of await websiteOwners(db, type, org)) if (!retired.has(id)) owners.add(id);
  const all = [...owners];

  const [umbrella] = await db
    .select({ domain: sharedOrgDomains.domain })
    .from(sharedOrgDomains)
    .where(eq(sharedOrgDomains.domain, org))
    .limit(1);
  if (umbrella) return none(`${org} is an operator-listed shared domain`, true, all);
  if (all.length > 1)
    return none(
      `${org} is on the domain list of ${all.length} ${type}s (shared, ambiguous)`,
      true,
      all
    );
  if (all.length === 0) return none(`${org} is on no ${type}'s domain list`);
  return { ids: all, allOwners: all, shared: false, reason: "" };
}

export interface OrgDomainEntry {
  domain: string;
  status: "active" | "candidate" | "retired";
  method: OrgDomainMethod;
  evidence: string | null;
  sourceUrl: string | null;
  inboundEmailId: string | null;
  addedBy: string;
  /** NULL for the implicit website member. */
  id: string | null;
  createdAt: Date | null;
}

/** An org's full list, implicit website member included. */
export async function orgDomainList(
  db: Db,
  type: OrgDomainEntityType,
  entityId: string
): Promise<OrgDomainEntry[]> {
  const t = tableFor(type);
  const [row] = await db.select({ website: t.website }).from(t).where(eq(t.id, entityId)).limit(1);
  const stored = await db
    .select()
    .from(orgDomains)
    .where(and(eq(orgDomains.entityType, type), eq(orgDomains.entityId, entityId)));
  const out: OrgDomainEntry[] = stored.map((r) => ({
    domain: r.domain,
    status: r.status,
    method: r.method,
    evidence: r.evidence,
    sourceUrl: r.sourceUrl,
    inboundEmailId: r.inboundEmailId,
    addedBy: r.addedBy,
    id: r.id,
    createdAt: r.createdAt,
  }));
  const site = ownableOrgDomain(row?.website);
  if (site && !stored.some((r) => r.domain === site))
    out.unshift({
      domain: site,
      status: "active",
      method: "website",
      evidence: `website field: ${row?.website}`,
      sourceUrl: row?.website ?? null,
      inboundEmailId: null,
      addedBy: "system:website-seed",
      id: null,
      createdAt: null,
    });
  return out.filter((e) => !isNonOwnableDomain(e.domain));
}

/**
 * The domains a matcher may use for this org: active, ownable, and NOT
 * shared. This is what "does this aligned domain belong to the org" reads.
 */
export async function matchableDomainsFor(
  db: Db,
  type: OrgDomainEntityType,
  entityId: string
): Promise<string[]> {
  const active = (await orgDomainList(db, type, entityId))
    .filter((e) => e.status === "active")
    .map((e) => e.domain);
  const out: string[] = [];
  for (const d of active) {
    const owners = await orgsForDomain(db, type, d);
    if (!owners.shared) out.push(d);
  }
  return out;
}

export type OrgDomainWriteResult =
  | { ok: true; changed: boolean; status: "active" | "candidate" | "retired"; domain: string }
  | { ok: false; reason: string };

async function audit(
  db: Db,
  action: string,
  targetId: string,
  actorUserId: string | null,
  payload: Record<string, unknown>,
  now: Date
) {
  await db.insert(adminActions).values({
    action,
    actorUserId,
    targetType: "org_domain",
    targetId,
    payloadJson: JSON.stringify(payload),
    createdAt: now,
  });
}

/**
 * Add a domain to an org's list, under the §2 rules. Audit-logged.
 *
 * Idempotent: an existing active row is left alone. A candidate is promoted
 * only by an add whose method makes it active. A RETIRED row is re-activated
 * by an operator only — automation never reverses an operator's retire.
 */
export async function addOrgDomain(
  db: Db,
  input: {
    entityType: OrgDomainEntityType;
    entityId: string;
    domain: string;
    method: OrgDomainAddMethod;
    senderValidated?: boolean;
    evidence?: string | null;
    sourceUrl?: string | null;
    inboundEmailId?: string | null;
    /** `system:<writer>` or `operator:<user id>`. */
    actor: string;
    actorUserId?: string | null;
    now?: Date;
  }
): Promise<OrgDomainWriteResult> {
  const now = input.now ?? new Date();
  const plan = planOrgDomainAdd(input);
  if (!plan.ok) return plan;
  const [existing] = await db
    .select()
    .from(orgDomains)
    .where(
      and(
        eq(orgDomains.entityType, input.entityType),
        eq(orgDomains.entityId, input.entityId),
        eq(orgDomains.domain, plan.domain)
      )
    )
    .limit(1);

  if (existing) {
    const reactivate =
      existing.status === "retired" && input.method === "operator" && plan.status === "active";
    const promote = existing.status === "candidate" && plan.status === "active";
    if (!reactivate && !promote)
      return { ok: true, changed: false, status: existing.status, domain: plan.domain };
    await db
      .update(orgDomains)
      .set({
        status: "active",
        method: input.method,
        evidence: input.evidence ?? existing.evidence,
        sourceUrl: input.sourceUrl ?? existing.sourceUrl,
        inboundEmailId: input.inboundEmailId ?? existing.inboundEmailId,
        addedBy: input.actor,
        retiredBy: null,
        retiredAt: null,
        updatedAt: now,
      })
      .where(eq(orgDomains.id, existing.id));
    await audit(
      db,
      "org_domain.added",
      existing.id,
      input.actorUserId ?? null,
      {
        entityType: input.entityType,
        entityId: input.entityId,
        domain: plan.domain,
        method: input.method,
        from: existing.status,
        to: "active",
        evidence: input.evidence ?? null,
        actor: input.actor,
      },
      now
    );
    return { ok: true, changed: true, status: "active", domain: plan.domain };
  }

  const id = crypto.randomUUID();
  await db
    .insert(orgDomains)
    .values({
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      domain: plan.domain,
      status: plan.status,
      method: input.method,
      evidence: input.evidence ?? null,
      sourceUrl: input.sourceUrl ?? null,
      inboundEmailId: input.inboundEmailId ?? null,
      addedBy: input.actor,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await audit(
    db,
    plan.status === "active" ? "org_domain.added" : "org_domain.candidate",
    id,
    input.actorUserId ?? null,
    {
      entityType: input.entityType,
      entityId: input.entityId,
      domain: plan.domain,
      method: input.method,
      to: plan.status,
      evidence: input.evidence ?? null,
      actor: input.actor,
    },
    now
  );
  return { ok: true, changed: true, status: plan.status, domain: plan.domain };
}

/**
 * Retire a domain (or reject a candidate). Works on the implicit website
 * member too, by writing a `retired` row for it. Audit-logged.
 */
export async function retireOrgDomain(
  db: Db,
  input: {
    entityType: OrgDomainEntityType;
    entityId: string;
    domain: string;
    actor: string;
    actorUserId?: string | null;
    reason?: string | null;
    now?: Date;
  }
): Promise<OrgDomainWriteResult> {
  const now = input.now ?? new Date();
  const domain = organizationalDomain(input.domain);
  if (!domain) return { ok: false, reason: `${input.domain} is not a registrable domain` };
  const list = await orgDomainList(db, input.entityType, input.entityId);
  const entry = list.find((e) => e.domain === domain);
  if (!entry) return { ok: false, reason: `${domain} is not on this ${input.entityType}'s list` };
  if (entry.status === "retired") return { ok: true, changed: false, status: "retired", domain };

  let id = entry.id;
  if (id) {
    await db
      .update(orgDomains)
      .set({ status: "retired", retiredBy: input.actor, retiredAt: now, updatedAt: now })
      .where(eq(orgDomains.id, id));
  } else {
    id = crypto.randomUUID();
    await db.insert(orgDomains).values({
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      domain,
      status: "retired",
      method: "website",
      evidence: entry.evidence,
      sourceUrl: entry.sourceUrl,
      addedBy: entry.addedBy,
      retiredBy: input.actor,
      retiredAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  await audit(
    db,
    "org_domain.retired",
    id,
    input.actorUserId ?? null,
    {
      entityType: input.entityType,
      entityId: input.entityId,
      domain,
      from: entry.status,
      method: entry.method,
      reason: input.reason ?? null,
      actor: input.actor,
    },
    now
  );
  return { ok: true, changed: true, status: "retired", domain };
}

/** Operator: mark (or unmark) an umbrella domain as always shared. Audit-logged. */
export async function setSharedOrgDomain(
  db: Db,
  input: {
    domain: string;
    shared: boolean;
    note?: string | null;
    actor: string;
    actorUserId?: string | null;
    now?: Date;
  }
): Promise<{ ok: true; domain: string; changed: boolean } | { ok: false; reason: string }> {
  const now = input.now ?? new Date();
  const domain = organizationalDomain(input.domain);
  if (!domain) return { ok: false, reason: `${input.domain} is not a registrable domain` };
  let changed: boolean;
  if (input.shared) {
    const res = await db
      .insert(sharedOrgDomains)
      .values({ domain, note: input.note ?? null, addedBy: input.actor, createdAt: now })
      .onConflictDoNothing()
      .returning({ domain: sharedOrgDomains.domain });
    changed = res.length > 0;
  } else {
    const res = await db
      .delete(sharedOrgDomains)
      .where(eq(sharedOrgDomains.domain, domain))
      .returning({ domain: sharedOrgDomains.domain });
    changed = res.length > 0;
  }
  if (changed)
    await audit(
      db,
      input.shared ? "org_domain.shared_marked" : "org_domain.shared_unmarked",
      domain,
      input.actorUserId ?? null,
      { domain, note: input.note ?? null, actor: input.actor },
      now
    );
  return { ok: true, domain, changed };
}

/** Active `org_domains` rows (any type) for a domain — the sender resolver's extra key. */
export async function orgDomainRowsFor(
  db: Db,
  value: string | null | undefined,
  types: readonly OrgDomainEntityType[] = ORG_DOMAIN_ENTITY_TYPES
): Promise<Array<{ entityType: OrgDomainEntityType; entityId: string }>> {
  const org = ownableOrgDomain(value);
  if (!org) return [];
  return db
    .select({ entityType: orgDomains.entityType, entityId: orgDomains.entityId })
    .from(orgDomains)
    .where(
      and(
        eq(orgDomains.domain, org),
        eq(orgDomains.status, "active"),
        inArray(orgDomains.entityType, [...types])
      )
    )
    .limit(50);
}
