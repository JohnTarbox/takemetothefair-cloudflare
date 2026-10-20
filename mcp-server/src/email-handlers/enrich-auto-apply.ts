/**
 * OPE-1506 — enrich-on-match AUTO-APPLIES to EMPTY fields for trusted senders
 * and verified organizers. John, 2026-10-20 09:36 ET: "trusted and verified
 * senders' updates to empty fields should be applied automatically." This is
 * his issue-level approval for an automated write to a public event page,
 * limited to the predicate below; everyone else stays stage-only (OPE-175 /
 * OPE-1152, unchanged).
 *
 * ALL of these must hold, or nothing is applied and everything stays staged:
 *
 *  1. SENDER — the hop that reached us passed an ALIGNED DMARC check
 *     (`sender_auth = 'pass'`) AND is one of:
 *       - `trusted`          — `inbound_email_senders.trust_status = 'trusted'`;
 *       - `verified-contact` — a `validated` promoter contact of THIS event's
 *                              promoter (a contact of another promoter does not
 *                              qualify);
 *       - `dmarc-aligned`    — its From domain is THIS promoter's website domain.
 *     The DMARC requirement on every basis is deliberately stricter than the
 *     ticket's text: a `From:` header is spoofable, and OPE-1369 already holds
 *     the trusted fast path to the same bar. ⚠️ The auth columns on
 *     inbound_emails are documented REPORT-ONLY (OPE-763); this is the ruling
 *     that lets one decision branch on them, and only this one.
 *  2. MATCH — unambiguous: the OPE-1505 text matcher's single clear leader, an
 *     exact `source_url` match, or a series (occurrence) match. A fuzzy
 *     venue/date/name dedup match stays staged.
 *  3. FIELD — empty on the event (NULL / '' / `UNSET` for pet_friendly), checked
 *     AGAIN in the UPDATE's own WHERE so a concurrent edit is never overwritten.
 *  4. FIELD — in the allowed set below. Never: name, dates, venue, promoter,
 *     status, lifecycle, description, categories, source_url.
 *
 * Every applied field gets a citation row in the same pass and one
 * `dedup.enrich_applied` audit row lists old → new for all of them, so every
 * write is traceable and reversible by hand.
 *
 * AMENDMENT (John, 2026-10-20 12:42 ET) — for the `verified-contact` basis ONLY,
 * rule 3 is dropped: a validated contact's value REPLACES a filled field (the
 * allowed set is unchanged). The replaced value goes on the audit row, the prior
 * citation is superseded (the contact wins over the organizer's website), and
 * when the replaced value came from the organizer's published page the row
 * carries `conflictWithSourceUrl` so the reply can name the conflict. Trusted
 * forwards and DMARC-aligned non-contacts stay empty-only. Hours stay
 * days-without-hours only for every basis: re-timing days that already have
 * hours is the OPE-479 shape, and the amendment's specimen is not about hours.
 */
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  adminActions,
  eventDataCitations,
  eventDays,
  events,
  inboundEmails,
  inboundEmailSenders,
  promoterContacts,
} from "../schema.js";
import type { Db } from "../db.js";
import { normalizeEventDate, registrableDomain } from "@takemetothefair/utils";
import { citationSupersedeScope } from "@takemetothefair/db-schema";
import { writeEventVisitorNoteCitation, VISITOR_NOTE_MAX } from "../tools/visitor-notes.js";
import { writeEventPetCitation } from "../tools/pet-friendly.js";
import { gateUrlForField, loadClassifications } from "../url-classification.js";

export const ENRICH_APPLIED_ACTION = "dedup.enrich_applied";

export type AutoApplyBasis = "trusted" | "verified-contact" | "dmarc-aligned";

const PUBLIC_HOST = "https://meetmeatthefair.com";

/**
 * The fields that may be written, keyed by the stager's proposal column.
 *
 * `image_url` is in the ruling's allowed set but is NOT applied here: an image
 * from an email extraction is an external URL, and writing it would hotlink a
 * third-party image onto a public page — the unresolved OPE-294 question. It
 * stays staged for a human, like every field outside this map.
 */
const SCALAR_COLUMNS = {
  ticket_url: "ticketUrl",
  ticket_price_min_cents: "ticketPriceMinCents",
  ticket_price_max_cents: "ticketPriceMaxCents",
  vendor_fee_min_cents: "vendorFeeMinCents",
  vendor_fee_max_cents: "vendorFeeMaxCents",
  vendor_fee_notes: "vendorFeeNotes",
  application_url: "applicationUrl",
  application_deadline: "applicationDeadline",
  application_instructions: "applicationInstructions",
  walk_ins_allowed: "walkInsAllowed",
  indoor_outdoor: "indoorOutdoor",
  estimated_attendance: "estimatedAttendance",
} as const satisfies Record<string, keyof typeof events.$inferSelect>;

const VISITOR_NOTE_COLUMNS = {
  parking_notes: "parkingNotes",
  accessibility_notes: "accessibilityNotes",
} as const;

export const AUTO_APPLY_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(SCALAR_COLUMNS),
  ...Object.keys(VISITOR_NOTE_COLUMNS),
  "pet_friendly",
  "event_days.hours",
]);

/** The amendment's overwrite set: every auto-apply field except hours. */
export const OVERWRITE_FIELDS: ReadonlySet<string> = new Set(
  [...AUTO_APPLY_FIELDS].filter((f) => f !== "event_days.hours")
);

/** Proposal paths whose match is unambiguous (requirement 2). */
export function isUnambiguousMatch(path: string, matchType: string | null): boolean {
  if (path === "text-match" || path === "occurrence-exists") return true;
  return matchType === "exact_url";
}

function domainOf(addressOrUrl: string | null | undefined): string | null {
  if (!addressOrUrl) return null;
  try {
    const host = addressOrUrl.includes("@")
      ? addressOrUrl.split("@").pop()!
      : new URL(/^https?:\/\//i.test(addressOrUrl) ? addressOrUrl : `https://${addressOrUrl}`)
          .hostname;
    return host ? registrableDomain(host.trim()) : null;
  } catch {
    return null;
  }
}

/** Requirement 1. Returns the basis, or null with the reason it failed. */
export async function resolveAutoApplyBasis(
  db: Db,
  args: { inboundEmailId: string; promoterId: string | null; promoterWebsite: string | null }
): Promise<{
  basis: AutoApplyBasis | null;
  reason: string;
  senderAddress: string | null;
  receivedAt?: Date | null;
}> {
  const [row] = await db
    .select({
      fromAddress: inboundEmails.fromAddress,
      senderAuth: inboundEmails.senderAuth,
      receivedAt: inboundEmails.receivedAt,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, args.inboundEmailId))
    .limit(1);
  if (!row) return { basis: null, reason: "inbound row not found", senderAddress: null };
  const from = row.fromAddress.trim().toLowerCase();
  if (row.senderAuth !== "pass") {
    return {
      basis: null,
      reason: `sender_auth is ${row.senderAuth ?? "NULL"}, not an aligned DMARC pass`,
      senderAddress: from,
    };
  }
  const [trust] = await db
    .select({ status: inboundEmailSenders.trustStatus })
    .from(inboundEmailSenders)
    .where(eq(inboundEmailSenders.email, from))
    .limit(1);
  const receivedAt = row.receivedAt ?? null;
  if (trust?.status === "trusted") {
    return { basis: "trusted", reason: "trusted sender", senderAddress: from, receivedAt };
  }
  if (args.promoterId) {
    const [contact] = await db
      .select({ id: promoterContacts.id })
      .from(promoterContacts)
      .where(
        and(
          eq(promoterContacts.promoterId, args.promoterId),
          sql`lower(${promoterContacts.email}) = ${from}`,
          eq(promoterContacts.status, "validated")
        )
      )
      .limit(1);
    if (contact) {
      return {
        basis: "verified-contact",
        reason: "validated contact of this promoter",
        senderAddress: from,
        receivedAt,
      };
    }
    const fromDomain = domainOf(from);
    const siteDomain = domainOf(args.promoterWebsite);
    if (fromDomain && siteDomain && fromDomain === siteDomain) {
      return {
        basis: "dmarc-aligned",
        reason: `DMARC pass aligned to ${siteDomain}`,
        senderAddress: from,
        receivedAt,
      };
    }
  }
  return {
    basis: null,
    reason: "not trusted, not a validated contact, not the promoter's domain",
    senderAddress: from,
  };
}

export interface AppliedField {
  field: string;
  /** The value replaced — null for an empty-field fill. */
  old: unknown;
  new: unknown;
  citationId: string | null;
  /** True when a filled value was replaced (verified-contact amendment). */
  overwrote: boolean;
  /** The active citation this write superseded, if any. */
  supersededCitationId: string | null;
  /** On an overwrite: the organizer's published page the replaced value came
   *  from, when it did. The reply drafter names this conflict to the contact. */
  conflictWithSourceUrl: string | null;
}

/** The citation's field name and value for a scalar column. */
function citationFor(field: string, value: unknown): { name: string; value: string } {
  if (field.endsWith("_cents") && typeof value === "number") {
    return { name: field.replace(/_cents$/, ""), value: (value / 100).toFixed(2) };
  }
  if (value instanceof Date) return { name: field, value: value.toISOString().slice(0, 10) };
  return { name: field, value: String(value) };
}

/** The field name a citation row uses for a proposal field. */
function citationFieldName(field: string): string {
  if (field === "event_days.hours") return "hours";
  return field.replace(/_cents$/, "");
}

interface PriorCitation {
  id: string;
  sourceUrl: string;
  sourceType: string;
}

async function activeCitation(
  db: Db,
  eventId: string,
  fieldName: string
): Promise<PriorCitation | null> {
  const [row] = await db
    .select({
      id: eventDataCitations.id,
      sourceUrl: eventDataCitations.sourceUrl,
      sourceType: eventDataCitations.sourceType,
    })
    .from(eventDataCitations)
    .where(
      and(citationSupersedeScope(eventId, fieldName, null), eq(eventDataCitations.state, "active"))
    )
    .orderBy(desc(eventDataCitations.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Did the value being replaced come from the organizer's own published page?
 * Cited: the citation is `official_website`, or its domain is the promoter's
 * site or the event's source page. A prior citation to anything else (an
 * earlier email, a news story) is not a conflict with their page. Uncited: a
 * filled, uncited value on an event with a `source_url` came from importing
 * that page — the only route that fills fields without a citation.
 */
export function conflictSource(
  prior: PriorCitation | null,
  eventSourceUrl: string | null | undefined,
  promoterWebsite: string | null | undefined
): string | null {
  if (prior) {
    const d = domainOf(prior.sourceUrl);
    const own = [domainOf(promoterWebsite), domainOf(eventSourceUrl)].filter(Boolean);
    if (prior.sourceType === "official_website" || (d && own.includes(d))) return prior.sourceUrl;
    return null;
  }
  return eventSourceUrl || null;
}

async function writeCitation(
  db: Db,
  args: { eventId: string; field: string; value: string; sourceUrl: string; sourceName: string }
): Promise<string> {
  const scope = and(
    citationSupersedeScope(args.eventId, args.field, null),
    eq(eventDataCitations.state, "active")
  );
  const now = new Date();
  const [prior] = await db
    .select({ id: eventDataCitations.id })
    .from(eventDataCitations)
    .where(scope)
    .orderBy(desc(eventDataCitations.createdAt))
    .limit(1);
  if (prior) {
    await db.update(eventDataCitations).set({ state: "superseded", updatedAt: now }).where(scope);
  }
  const id = crypto.randomUUID();
  await db.insert(eventDataCitations).values({
    id,
    eventId: args.eventId,
    fieldName: args.field,
    value: args.value,
    year: null,
    sourceUrl: args.sourceUrl,
    sourceName: args.sourceName,
    sourceType: "user_submitted",
    confidence: null,
    state: "active",
    notes: "OPE-1506 — auto-applied from a trusted/verified organizer email",
    supersedesCitationId: prior?.id ?? null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const blank = (v: unknown) => v == null || v === "" || v === "UNSET";
const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/**
 * Apply the allowed proposals. Each write is a guarded UPDATE whose RETURNING
 * row proves it landed:
 *  - `proposals` (fields that were empty when staged) — `WHERE <col> is empty`;
 *    a field filled meanwhile is skipped, not overwritten, and stays staged.
 *  - `overwrites` (verified-contact only; fields holding a DIFFERENT value) —
 *    compare-and-set on the value read just before (`WHERE <col> = old`), so a
 *    concurrent edit is never clobbered. A field that fails stays unstaged.
 */
export async function applyEmptyFields(
  db: Db,
  args: {
    eventId: string;
    proposals: Record<string, unknown>;
    inboundEmailId: string;
    receivedAt: Date | null;
    overwrites?: Record<string, unknown>;
    eventSourceUrl?: string | null;
    promoterWebsite?: string | null;
  }
): Promise<{
  applied: AppliedField[];
  notApplied: Record<string, unknown>;
  notOverwritten: Record<string, unknown>;
  errors: Record<string, string>;
}> {
  const applied: AppliedField[] = [];
  const notApplied: Record<string, unknown> = {};
  const notOverwritten: Record<string, unknown> = {};
  const sourceUrl = `${PUBLIC_HOST}/admin/inbound-emails#${args.inboundEmailId}`;
  const day = (args.receivedAt ?? new Date()).toISOString().slice(0, 10);
  const sourceName = `Organizer email received ${day} (inbound ${args.inboundEmailId.slice(0, 8)})`;
  const classifications = await loadClassifications(db);
  const now = new Date();

  const errors: Record<string, string> = {};
  const run = async (field: string, raw: unknown, overwrite: boolean) => {
    const miss = overwrite ? notOverwritten : notApplied;
    try {
      await applyOne(field, raw, overwrite, miss);
    } catch (e) {
      // A field that failed BEFORE its write stays staged. One that was written
      // and then failed its citation stays in `applied` (citationId null) — the
      // audit row must never miss a real write.
      if (!applied.some((a) => a.field === field)) miss[field] = raw;
      errors[field] = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
  };
  for (const [field, raw] of Object.entries(args.proposals)) await run(field, raw, false);
  for (const [field, raw] of Object.entries(args.overwrites ?? {})) await run(field, raw, true);
  return { applied, notApplied, notOverwritten, errors };

  /**
   * The guard for one events column: empty for a fill; for an overwrite, the
   * value read now (compare-and-set). Returns null when there is nothing to do
   * (an overwrite whose stored value already equals the new one).
   */
  async function guardFor(
    colKey: keyof typeof events.$inferSelect,
    value: unknown,
    overwrite: boolean
  ): Promise<{ where: ReturnType<typeof and>; old: unknown } | null> {
    const col = events[colKey as keyof typeof events] as never;
    const empty =
      colKey === "petFriendly"
        ? or(isNull(col), eq(col, "UNSET" as never))
        : typeof value === "string"
          ? or(isNull(col), eq(col, sql`''`))
          : isNull(col);
    if (!overwrite) return { where: and(eq(events.id, args.eventId), empty), old: null };
    const [cur] = await db
      .select({ v: col })
      .from(events)
      .where(eq(events.id, args.eventId))
      .limit(1);
    const old = (cur as { v: unknown } | undefined)?.v ?? null;
    // Emptied since staging: an ordinary fill, under the empty guard.
    if (blank(old)) return { where: and(eq(events.id, args.eventId), empty), old: null };
    if (same(old, value)) return null;
    return { where: and(eq(events.id, args.eventId), eq(col, old as never)), old };
  }

  async function record(
    field: string,
    value: unknown,
    old: unknown,
    writeCite: () => Promise<string | null>
  ): Promise<void> {
    const overwrote = !blank(old);
    const prior = await activeCitation(db, args.eventId, citationFieldName(field));
    const entry: AppliedField = {
      field,
      old,
      new: value,
      citationId: null,
      overwrote,
      supersededCitationId: prior?.id ?? null,
      conflictWithSourceUrl: overwrote
        ? conflictSource(prior, args.eventSourceUrl, args.promoterWebsite)
        : null,
    };
    applied.push(entry);
    entry.citationId = await writeCite();
  }

  async function applyOne(
    field: string,
    raw: unknown,
    overwrite: boolean,
    miss: Record<string, unknown>
  ): Promise<void> {
    const allowed = overwrite ? OVERWRITE_FIELDS : AUTO_APPLY_FIELDS;
    if (!allowed.has(field)) {
      miss[field] = raw;
      return;
    }

    if (field in SCALAR_COLUMNS) {
      const colKey = SCALAR_COLUMNS[field as keyof typeof SCALAR_COLUMNS];
      let value: unknown = raw;
      if (field === "application_deadline") value = normalizeEventDate(raw as string);
      if (field === "ticket_url") value = gateUrlForField(raw as string, "ticket", classifications);
      if (field === "application_url")
        value = gateUrlForField(raw as string, "application", classifications);
      if (value == null) {
        miss[field] = raw;
        return;
      }
      const g = await guardFor(colKey, value, overwrite);
      if (!g) {
        miss[field] = raw;
        return;
      }
      const done = await db
        .update(events)
        .set({ [colKey]: value, updatedAt: now } as never)
        .where(g.where)
        .returning({ id: events.id });
      if (done.length === 0) {
        miss[field] = raw;
        return;
      }
      const c = citationFor(field, value);
      await record(field, value, g.old, () =>
        writeCitation(db, {
          eventId: args.eventId,
          field: c.name,
          value: c.value,
          sourceUrl,
          sourceName,
        })
      );
      return;
    }

    if (field in VISITOR_NOTE_COLUMNS) {
      const fact = raw as { value: string; excerpt: string };
      if (!fact?.value || !fact.excerpt || fact.value.length > VISITOR_NOTE_MAX) {
        miss[field] = raw;
        return;
      }
      const colKey = VISITOR_NOTE_COLUMNS[field as keyof typeof VISITOR_NOTE_COLUMNS];
      const g = await guardFor(colKey, fact.value, overwrite);
      if (!g) {
        miss[field] = raw;
        return;
      }
      const done = await db
        .update(events)
        .set({ [colKey]: fact.value, updatedAt: now } as never)
        .where(g.where)
        .returning({ id: events.id });
      if (done.length === 0) {
        miss[field] = raw;
        return;
      }
      await record(field, fact.value, g.old, () =>
        writeEventVisitorNoteCitation(db, {
          eventId: args.eventId,
          field: field as "parking_notes" | "accessibility_notes",
          value: fact.value,
          evidence: {
            source_url: sourceUrl,
            source_type: "user_submitted",
            source_name: sourceName,
            excerpt: fact.excerpt,
          },
          userId: null,
        })
      );
      return;
    }

    if (field === "pet_friendly") {
      const fact = raw as { value: string; excerpt: string };
      if ((fact?.value !== "YES" && fact?.value !== "NO") || !fact.excerpt) {
        miss[field] = raw;
        return;
      }
      const g = await guardFor("petFriendly", fact.value, overwrite);
      if (!g) {
        miss[field] = raw;
        return;
      }
      const done = await db
        .update(events)
        .set({ petFriendly: fact.value, updatedAt: now })
        .where(g.where)
        .returning({ id: events.id });
      if (done.length === 0) {
        miss[field] = raw;
        return;
      }
      await record(field, fact.value, g.old, () =>
        writeEventPetCitation(db, {
          eventId: args.eventId,
          value: fact.value as "YES" | "NO",
          evidence: {
            source_url: sourceUrl,
            source_type: "user_submitted",
            source_name: sourceName,
            excerpt: fact.excerpt,
          },
          userId: null,
        })
      );
      return;
    }

    if (field === "event_days.hours") {
      // Uniform hours only: one open and one close time. Per-day hours or a
      // free-text note stay staged — hours are the field this project has been
      // burned on (OPE-479), and a guess here is a wrong time on a public page.
      // Never an overwrite (OVERWRITE_FIELDS excludes it): only days with none.
      const h = raw as {
        startTime?: string;
        endTime?: string;
        dayHours?: unknown[];
        hoursNotes?: string;
      };
      const HHMM = /^\d{2}:\d{2}$/;
      if (
        !h?.startTime ||
        !h.endTime ||
        !HHMM.test(h.startTime) ||
        !HHMM.test(h.endTime) ||
        h.dayHours?.length
      ) {
        miss[field] = raw;
        return;
      }
      const done = await db
        .update(eventDays)
        .set({ openTime: h.startTime, closeTime: h.endTime })
        .where(
          and(
            eq(eventDays.eventId, args.eventId),
            isNull(eventDays.openTime),
            isNull(eventDays.closeTime),
            eq(eventDays.hoursUnpublished, 0)
          )
        )
        .returning({ id: eventDays.id });
      if (done.length === 0) {
        miss[field] = raw;
        return;
      }
      await record(
        field,
        { openTime: h.startTime, closeTime: h.endTime, days: done.length },
        null,
        () =>
          writeCitation(db, {
            eventId: args.eventId,
            field: "hours",
            value: `${h.startTime}-${h.endTime} on ${done.length} day(s) that had none`,
            sourceUrl,
            sourceName,
          })
      );
    }
  }
}

/** The audit row: one per auto-applied match, listing every write. */
export async function recordEnrichApplied(
  db: Db,
  args: {
    eventId: string;
    applied: AppliedField[];
    basis: AutoApplyBasis;
    inboundEmailId: string;
    path: string;
    matchType: string | null;
  }
): Promise<void> {
  await db.insert(adminActions).values({
    action: ENRICH_APPLIED_ACTION,
    actorUserId: null,
    targetType: "event",
    targetId: args.eventId,
    payloadJson: JSON.stringify({
      fields: args.applied,
      basis: args.basis,
      inboundEmailId: args.inboundEmailId,
      path: args.path,
      matchType: args.matchType,
    }),
    createdAt: new Date(),
  });
}
