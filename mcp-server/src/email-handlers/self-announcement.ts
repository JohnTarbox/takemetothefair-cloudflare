/**
 * OPE-1139 — an exhibitor's own "visit us at Booth N" email records the
 * exhibitor, not just the event.
 *
 * Specimen: inbound `0cb048f4`. John forwarded Central Coating Technologies'
 * Constant Contact campaign ("Visit us at Booth 510" at the D2P trade show).
 * The pipeline created the event and dropped the one fact the email existed to
 * state: that the SENDER exhibits there. OPE-176/847 cover a ROSTER (a list of
 * other people's names); here the exhibitor is the sender, in the first person,
 * and there is no list.
 *
 * ## The write rule (John, 2026-09-30, option A)
 *
 *  - a business ALREADY in the vendor list, matched exactly (website domain, or
 *    `findStrictMatch` on its name), is linked live: EXHIBITOR / CONFIRMED,
 *    with `booth_info`;
 *  - a business NOT already a vendor is STAGED in `exhibitor_proposals`. No
 *    vendor row is created, because a vendor row is a public page.
 *
 * ## Trust: only a VERIFIED original sender
 *
 * The lane runs only when the email is a forward whose attached original
 * carried a DKIM signature that VERIFIED and aligned with its From domain
 * (OPE-944's `original_sender_auth='verified'` + `original_sender_domain_aligned`).
 * Those columns are otherwise report-only; this lane is the one consumer John
 * authorised. A quoted inline forward is prose (anyone can type "From:"), and
 * the forwarder is never the exhibitor: an internal or freemail sender domain
 * declines rather than resolving to our own account.
 *
 * Direct (non-forwarded) self-announcements are out of scope for v1: the outer
 * `sender_auth` is a different signal with its own open ruling (OPE-765).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createOrLinkVendor,
  findStrictMatch,
  type CreateOrLinkVendorDeps,
  type VendorLinkDb,
} from "@takemetothefair/vendor-linking";
import { exhibitorProposals, vendors } from "../schema.js";
import type { Db } from "../db.js";

/** First-person exhibit language. Each must be about US, never a third party. */
const FIRST_PERSON = [
  /\b(?:come\s+)?(?:visit|see|find|meet)\s+us\b/i,
  /\bstop\s+by\s+(?:and\s+see\s+us|our\s+(?:booth|table|stand))\b/i,
  /\bwe(?:'|’)?(?:ll|\s+will)\s+be\s+(?:exhibiting|at\s+booth|in\s+booth|showing|there)\b/i,
  /\bwe\s+are\s+exhibiting\b/i,
  /\bour\s+(?:booth|stand)\b/i,
];

/** The exhibit half: a booth / stand / table reference, or "exhibit". */
const EXHIBIT_CONTEXT = /\b(?:booth|stand|exhibit(?:ing|or)?)\b/i;

/** `Booth 510`, `booth #12B`, `Booth No. 7`, `Stand 4`. */
const BOOTH_NUMBER = /\b(booth|stand)\s*(?:#|no\.?|number)?\s*:?\s*([A-Z]?\d{1,5}[A-Z]?)\b/gi;

export interface SelfAnnouncement {
  /** The first-person phrase that matched, for the step record. */
  phrase: string;
  /** "Booth 510" when the email names exactly one; null when none or several. */
  boothInfo: string | null;
}

/**
 * Detect "we are exhibiting there" in the sender's own words. Requires BOTH a
 * first-person phrase and an exhibit/booth reference: "visit us at our website"
 * is not an exhibit claim, and an organizer's "visit the show, 300 exhibitors"
 * has no first person.
 */
export function detectSelfAnnouncement(text: string | null | undefined): SelfAnnouncement | null {
  if (!text) return null;
  let phrase: string | null = null;
  for (const re of FIRST_PERSON) {
    const m = text.match(re);
    if (m) {
      phrase = m[0];
      break;
    }
  }
  if (!phrase || !EXHIBIT_CONTEXT.test(text)) return null;

  const booths = new Set<string>();
  for (const m of text.matchAll(BOOTH_NUMBER)) {
    const kind = m[1].toLowerCase() === "stand" ? "Stand" : "Booth";
    booths.add(`${kind} ${m[2].toUpperCase()}`);
  }
  // Several booth numbers means several shows or a floor plan; naming one would
  // be a guess, and a wrong booth is worse than none.
  return { phrase, boothInfo: booths.size === 1 ? [...booths][0] : null };
}

/** Sender domains that never identify a business. */
const NON_BUSINESS_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "proton.me",
  "protonmail.com",
  "meetmeatthefair.com",
]);

export interface ExhibitorIdentity {
  domain: string;
  website: string;
  /** From the CAN-SPAM footer ("Name | 165 Street | Town, ST 01583"); may be null. */
  businessName: string | null;
  city: string | null;
  state: string | null;
}

/** The registrable-ish host of an address or URL: lowercased, no `www.`. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at !== -1 && !v.includes("/")) return v.slice(at + 1).replace(/^www\./, "") || null;
  try {
    const u = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`);
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Who the exhibitor is, from the ORIGINAL sender only. Null when the sender
 * domain cannot name a business (freemail, our own domain).
 */
export function exhibitorIdentity(
  originalSenderAddress: string | null | undefined,
  body: string | null | undefined
): ExhibitorIdentity | null {
  const domain = hostOf(originalSenderAddress);
  if (!domain || NON_BUSINESS_DOMAINS.has(domain)) return null;
  let businessName: string | null = null;
  let city: string | null = null;
  let state: string | null = null;
  // CAN-SPAM footer: "Central Coating Technologies | 165 Shrewsbury Street | West Boylston, MA 01583 US".
  // Bodies are often a single line, so anchor on the street-address separator
  // and take only the LAST segment before it (split on runs of spaces, sentence
  // ends and bare URLs); a greedy left edge swallowed the line-card text above.
  const text = body ?? "";
  const addr = text.match(/\s\|\s*\d+[^|]{2,80}\|\s*([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\b/);
  if (addr && addr.index !== undefined) {
    const candidate = text
      .slice(0, addr.index)
      .split(/\s{2,}|[!?]\s+|\bwww\.\S+\s*|https?:\/\/\S+\s*/)
      .pop()
      ?.trim()
      .replace(/,?\s*(Inc|LLC|Co|Corp)\.?$/i, "")
      .trim();
    if (candidate && candidate.length <= 80 && candidate.split(/\s+/).length <= 8) {
      businessName = candidate;
    }
    city = addr[1].trim();
    state = addr[2];
  }
  return { domain, website: `https://${domain}`, businessName, city, state };
}

export type SelfAnnouncementOutcome =
  | { kind: "linked" | "already_linked"; vendorId: string; matchedBy: "domain" | "name" }
  | { kind: "proposed"; proposalId: string; reason: "no_match" | "ambiguous_domain" }
  | { kind: "declined"; reason: string };

/** Vendors whose website is on exactly this host. Live rows only. */
async function vendorsOnDomain(db: Db, domain: string) {
  const rows = await db
    .select({ id: vendors.id, businessName: vendors.businessName, website: vendors.website })
    .from(vendors)
    .where(
      and(
        isNull(vendors.deletedAt),
        // instr, not LIKE: D1 caps LIKE patterns at 50 chars.
        sql`instr(lower(${vendors.website}), ${domain}) > 0`
      )
    )
    .limit(20);
  return rows.filter((r) => hostOf(r.website) === domain);
}

/**
 * Link the sender as an exhibitor, or stage them. Never creates a vendor row.
 * Idempotent: a re-run links nothing new (createOrLinkVendor reports
 * already-linked) and stages nothing twice (unique on email + event).
 */
export async function recordSelfAnnouncedExhibitor(
  db: Db,
  input: {
    eventId: string;
    inboundEmailId: string;
    originalSenderAddress: string | null;
    originalSenderAuth: string | null;
    originalSenderDomainAligned: number | boolean | null;
    body: string | null;
  },
  deps: CreateOrLinkVendorDeps
): Promise<SelfAnnouncementOutcome> {
  if (input.originalSenderAuth !== "verified" || !input.originalSenderDomainAligned) {
    return { kind: "declined", reason: "original_sender_not_verified" };
  }
  const announcement = detectSelfAnnouncement(input.body);
  if (!announcement) return { kind: "declined", reason: "no_first_person_exhibit_language" };
  const who = exhibitorIdentity(input.originalSenderAddress, input.body);
  if (!who) return { kind: "declined", reason: "sender_domain_not_a_business" };

  const byDomain = await vendorsOnDomain(db, who.domain);
  let match: { businessName: string; by: "domain" | "name" } | null = null;
  if (byDomain.length === 1) match = { businessName: byDomain[0].businessName, by: "domain" };
  else if (byDomain.length === 0 && who.businessName) {
    const strict = await findStrictMatch(db as unknown as VendorLinkDb, who.businessName);
    if (strict) match = { businessName: strict.businessName, by: "name" };
  }

  if (match) {
    // The stored name of an existing vendor, under `strict`, always resolves to
    // that vendor: this links, it never creates. Checked below anyway, because
    // a create here would be a public page nobody reviewed.
    const res = await createOrLinkVendor(
      db as unknown as VendorLinkDb,
      {
        eventId: input.eventId,
        businessName: match.businessName,
        dedupStrategy: "strict",
        status: "CONFIRMED",
        participationType: "EXHIBITOR",
        boothInfo: announcement.boothInfo,
      },
      deps
    );
    if (!res.ok) return { kind: "declined", reason: `link_failed: ${res.error}` };
    if (res.wasCreated) {
      // Unreachable by construction; loud if it ever happens.
      throw new Error(`self-announcement created vendor ${res.vendorId} — must only link`);
    }
    return {
      kind: res.wasAlreadyLinked ? "already_linked" : "linked",
      vendorId: res.vendorId,
      matchedBy: match.by,
    };
  }

  const proposalId = crypto.randomUUID();
  const inserted = await db
    .insert(exhibitorProposals)
    .values({
      id: proposalId,
      eventId: input.eventId,
      inboundEmailId: input.inboundEmailId,
      businessName: who.businessName,
      website: who.website,
      senderAddress: input.originalSenderAddress,
      city: who.city,
      state: who.state,
      boothInfo: announcement.boothInfo,
      evidence: announcement.phrase,
      status: "pending",
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: exhibitorProposals.id });
  if (inserted.length === 0) {
    const [existing] = await db
      .select({ id: exhibitorProposals.id })
      .from(exhibitorProposals)
      .where(
        and(
          eq(exhibitorProposals.inboundEmailId, input.inboundEmailId),
          eq(exhibitorProposals.eventId, input.eventId)
        )
      )
      .limit(1);
    return {
      kind: "proposed",
      proposalId: existing?.id ?? proposalId,
      reason: byDomain.length > 1 ? "ambiguous_domain" : "no_match",
    };
  }
  return {
    kind: "proposed",
    proposalId,
    reason: byDomain.length > 1 ? "ambiguous_domain" : "no_match",
  };
}
