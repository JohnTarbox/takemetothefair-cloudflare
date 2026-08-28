/**
 * OPE-604 — assemble the inputs a `vendor_inquiry` answer needs.
 *
 * ── What the operator sees today ──────────────────────────────────────────
 * `/admin/inbound-emails` shows a body of text and an intent label. Answering
 * the four predictable questions — is space available, what does a booth cost,
 * what attendance, what vendor options — takes the same six lookups every
 * time, and on 2026-08-27 (inbound `310394ed`, TIMEPROOFUSA re: Winterfair
 * Hartford 2026) those lookups surfaced three things invisible from that view.
 * The worst: the event's dates were a PROJECTION off the 2025 pattern with
 * `dates_confirmed = true` and ZERO citations, so a reply written from the
 * admin row would have quoted a stranger seven dates we invented.
 *
 * ── This module assembles; it does NOT answer ─────────────────────────────
 * No prose is generated here, deliberately, and the ticket is emphatic about
 * why: this codebase's failure mode is automated extraction asserting wrong
 * things confidently with nothing detecting it. An auto-responder quoting
 * unverified dates to an outside business would be strictly WORSE than today's
 * bare acknowledgement, because it would sound authoritative while being
 * wrong. Assemble the inputs; let a human write the sentence.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  events,
  eventDataCitations,
  eventDays,
  eventDiscrepancies,
  emailSendLedger,
  promoters,
  vendors,
} from "@takemetothefair/db-schema";
import type { Db } from "../db.js";

/**
 * Brand key: lowercase, alphanumerics only.
 *
 * ⚠️ Applied to BOTH sides, and that is the entire point. The incident is
 * usually described as "the sender writes one word, our row is spaced" — the
 * live data says the opposite. The stored row is `TIMEPROOFUSA` (unspaced,
 * created 2026-06-28, two months BEFORE the inquiry) and there is no spaced
 * row at all. `search_vendors` uses `LIKE '%…%'`, and SQLite's LIKE is
 * ASCII-case-insensitive, so searching the unspaced form finds it fine.
 *
 * What fails is the other direction: reading "Time Proof USA" off the sender's
 * signature and searching THAT against an unspaced row. A substring match
 * cannot bridge inserted spaces in either direction, so normalising one side
 * only would fix half the cases and leave the half that actually occurred.
 */
export function brandKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** How a vendor row was found — reported so the operator can judge the match. */
export type VendorMatchVariant = "exact" | "brand-key" | "fragment" | "website-domain";

export interface VendorMatch {
  id: string;
  businessName: string;
  slug: string;
  website: string | null;
  matchedVariant: VendorMatchVariant;
  /** The string that produced the hit. */
  matchedOn: string;
}

/**
 * Candidate names for the sender, most specific first.
 *
 * The email domain is included because it is the one identifier a sender
 * cannot restyle between messages — `events@timeproofusa.com` yields
 * `timeproofusa` whatever the signature block says this week.
 */
export function senderNameVariants(fromAddress: string, signatureName?: string | null): string[] {
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  };
  push(signatureName);
  const at = fromAddress.indexOf("@");
  if (at > 0) {
    const domain = fromAddress.slice(at + 1).toLowerCase();
    // Strip the public suffix and any leading `www.`/`mail.` label.
    const label = domain.replace(/^(www|mail|smtp)\./, "").split(".")[0];
    push(label);
    push(domain);
  }
  return out;
}

/**
 * Find the vendor, trying progressively looser variants and SAYING which hit.
 *
 * "No match" is a real answer here and must be distinguishable from "matched
 * loosely" — a fragment hit on a four-letter token is not evidence the sender
 * is that vendor, and an operator writing a reply needs to know which of those
 * they are looking at.
 */
export async function matchVendorByVariants(
  db: Db,
  variants: string[]
): Promise<{ match: VendorMatch | null; variantsTried: string[] }> {
  const variantsTried: string[] = [];

  for (const raw of variants) {
    const key = brandKey(raw);
    if (key.length < 3) continue;
    variantsTried.push(raw);

    // 1. Exact, case-insensitive, on either name surface.
    const exact = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        website: vendors.website,
      })
      .from(vendors)
      .where(
        and(
          isNull(vendors.deletedAt),
          sql`lower(${vendors.businessName}) = ${raw.toLowerCase()}
              OR lower(COALESCE(${vendors.displayName}, '')) = ${raw.toLowerCase()}`
        )
      )
      .limit(1);
    if (exact.length > 0) {
      return {
        match: { ...exact[0], matchedVariant: "exact", matchedOn: raw },
        variantsTried,
      };
    }

    // 2. Brand key — both sides stripped to alphanumerics. This is the one
    //    that bridges "Time Proof USA" and "TIMEPROOFUSA".
    //
    //    The nested replaces are ugly and deliberate: SQLite has no regex, and
    //    pulling 6,566 vendor rows into JS to compare them is worse on a read
    //    path. Measured at 30ms against prod.
    const despacedCol = sql`lower(
      replace(replace(replace(replace(replace(
        ${vendors.businessName}, ' ', ''), '.', ''), '-', ''), '''', ''), ',', '')
    )`;
    const byKey = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        website: vendors.website,
      })
      .from(vendors)
      .where(and(isNull(vendors.deletedAt), sql`${despacedCol} = ${key}`))
      .limit(1);
    if (byKey.length > 0) {
      return { match: { ...byKey[0], matchedVariant: "brand-key", matchedOn: raw }, variantsTried };
    }

    // 3. Website domain — a vendor whose stored site is this sender's domain.
    const bySite = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        website: vendors.website,
      })
      .from(vendors)
      .where(
        and(
          isNull(vendors.deletedAt),
          sql`${vendors.website} IS NOT NULL AND instr(lower(${vendors.website}), ${key}) > 0`
        )
      )
      .limit(1);
    if (bySite.length > 0) {
      return {
        match: { ...bySite[0], matchedVariant: "website-domain", matchedOn: raw },
        variantsTried,
      };
    }

    // 4. Fragment — a distinctive substring. Gated at 6 characters: shorter
    //    fragments match half the directory and a false "already a vendor"
    //    is worse for a reply than an honest "not found".
    if (key.length >= 6) {
      const byFragment = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          website: vendors.website,
        })
        .from(vendors)
        .where(and(isNull(vendors.deletedAt), sql`instr(${despacedCol}, ${key}) > 0`))
        .limit(1);
      if (byFragment.length > 0) {
        return {
          match: { ...byFragment[0], matchedVariant: "fragment", matchedOn: raw },
          variantsTried,
        };
      }
    }
  }

  return { match: null, variantsTried };
}

export interface EventConfidence {
  datesConfirmed: boolean;
  activeCitations: number;
  gateFlags: string | null;
  /** null when the event has no day rows to compare against. */
  endDateMatchesLastDay: boolean | null;
  openDiscrepancies: number;
  /** Present when the row asserts confirmed dates it cannot support. */
  warning: string | null;
}

/**
 * The event's confidence state, stated plainly.
 *
 * The single most useful line is "dates_confirmed=true, 0 citations", and it is
 * the standing trap: the column is `DEFAULT true` and unchecked, so 90.7% of
 * live events claim confirmed dates with no citation behind them. A zero count
 * is therefore reported as a WARNING rather than left as an empty field — an
 * empty field reads as "not looked up", which is exactly the confusion that
 * lets an unverified date reach a stranger.
 */
export async function readEventConfidence(db: Db, eventId: string): Promise<EventConfidence> {
  const [row] = await db
    .select({
      datesConfirmed: events.datesConfirmed,
      gateFlags: events.gateFlags,
      endDate: events.endDate,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  const [{ n: citations } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(eventDataCitations)
    .where(and(eq(eventDataCitations.eventId, eventId), eq(eventDataCitations.state, "active")));

  const [{ n: openDisc } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(eventDiscrepancies)
    .where(
      and(eq(eventDiscrepancies.eventId, eventId), eq(eventDiscrepancies.resolutionStatus, "open"))
    );

  const [lastDay] = await db
    .select({ date: eventDays.date })
    .from(eventDays)
    .where(eq(eventDays.eventId, eventId))
    .orderBy(desc(eventDays.date))
    .limit(1);

  const datesConfirmed = Boolean(row?.datesConfirmed);
  const activeCitations = Number(citations ?? 0);

  let endDateMatchesLastDay: boolean | null = null;
  if (lastDay?.date && row?.endDate) {
    endDateMatchesLastDay = row.endDate.toISOString().slice(0, 10) === lastDay.date;
  }

  const warnings: string[] = [];
  if (datesConfirmed && activeCitations === 0) {
    warnings.push(
      "dates_confirmed=true with 0 active citations — nothing supports these dates. " +
        "Do not quote them to an outside party without checking the organizer's own site."
    );
  }
  if (endDateMatchesLastDay === false) {
    warnings.push(
      "end_date disagrees with the last event_days row — the stored span may be a " +
        "carry-over from a previous edition."
    );
  }
  if (openDisc > 0) warnings.push(`${openDisc} open discrepancy row(s) on this event.`);

  return {
    datesConfirmed,
    activeCitations,
    gateFlags: row?.gateFlags ?? null,
    endDateMatchesLastDay,
    openDiscrepancies: Number(openDisc ?? 0),
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

export interface VendorInquiryBriefing {
  inboundEmailId: string;
  matchedEvent: {
    id: string;
    slug: string;
    name: string;
    url: string;
    matchedOn: "source_url" | "subject";
  } | null;
  confidence: EventConfidence | null;
  handoff: {
    sourceUrl: string | null;
    applicationUrl: string | null;
    applicationInstructions: string | null;
    promoterWebsite: string | null;
  } | null;
  vendor: VendorMatch | null;
  vendorVariantsTried: string[];
  priorSends: {
    sentAt: string | null;
    subject: string | null;
    source: string | null;
    status: string;
  }[];
  warnings: string[];
}

/**
 * Event-name words too common to identify anything on their own.
 *
 * "Festival" appears in hundreds of rows; "SoNo" appears in one. A
 * distinctive-token search is only safe once the generic half is removed.
 */
const GENERIC_EVENT_WORDS = new Set([
  "fair",
  "fairs",
  "festival",
  "festivals",
  "show",
  "shows",
  "expo",
  "market",
  "markets",
  "county",
  "annual",
  "the",
  "and",
  "for",
  "day",
  "days",
  "week",
  "weekend",
  "craft",
  "crafts",
  "home",
  "arts",
  "art",
  "food",
  "music",
]);

/**
 * The most identifying single token in a subject, or null.
 *
 * Exists because substring matching is brittle to a single letter: the live
 * subject "SoNo Art Festival" does not contain-match the stored event
 * "SoNo Arts Festival 2026" — ART vs ARTS — so the whole briefing came back
 * empty for a row whose event we hold, with citations and an application URL
 * ready to hand over. One character.
 */
export function distinctiveToken(query: string): string | null {
  // `match` rather than `split(/[^a-z0-9]+/)`: the split form is banned by the
  // #120 slug-defence lint rule. That rule is blunt on purpose and this is a
  // search tokenizer rather than slug generation — but matching the tokens
  // directly says what it means and needs no exemption.
  const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 4 && !GENERIC_EVENT_WORDS.has(t) && !/^\d+$/.test(t)
  );
  if (tokens.length === 0) return null;
  return tokens.sort((a, b) => b.length - a.length)[0];
}

/** Words that carry no event-name signal when matching a subject line. */
const SUBJECT_NOISE =
  /\b(vendor|inquiry|inquiries|enquiry|question|info|information|application|apply|booth|space|re|fwd|about|regarding)\b/gi;

/** Reduce a subject line to its likely event-name core. */
export function subjectToEventQuery(subject: string | null | undefined): string {
  return (
    (subject ?? "")
      .replace(/^(re|fwd|fw)\s*:\s*/gi, "")
      .replace(SUBJECT_NOISE, " ")
      .replace(/[^\w\s&'-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // Trim separators left behind once the boilerplate is removed.
      // "Winterfair Hartford 2026 - Vendor Inquiry" reduces to
      // "Winterfair Hartford 2026 -", and that trailing hyphen is not
      // cosmetic: the result is fed to `instr()` against `events.name`, so a
      // stray separator makes the lookup miss the event entirely.
      .replace(/^[\s&'-]+|[\s&'-]+$/g, "")
      .trim()
  );
}

export async function buildVendorInquiryBriefing(
  db: Db,
  inbound: {
    id: string;
    fromAddress: string;
    subject: string | null;
    parsedUrl: string | null;
    bodyText?: string | null;
  }
): Promise<VendorInquiryBriefing> {
  const warnings: string[] = [];

  // ── Event match ─────────────────────────────────────────────────────────
  // `source_url` first: an exact URL is evidence, a subject-line name match is
  // an inference, and conflating the two is how the wrong event's dates end up
  // in a reply.
  let matched: VendorInquiryBriefing["matchedEvent"] = null;
  if (inbound.parsedUrl) {
    const [byUrl] = await db
      .select({ id: events.id, slug: events.slug, name: events.name })
      .from(events)
      .where(and(eq(events.sourceUrl, inbound.parsedUrl), isNull(events.mergedInto)))
      .limit(1);
    if (byUrl) {
      matched = {
        ...byUrl,
        url: `https://meetmeatthefair.com/events/${byUrl.slug}`,
        matchedOn: "source_url",
      };
    }
  }
  if (!matched) {
    const q = subjectToEventQuery(inbound.subject);
    // 50-char cap: D1's LIKE-pattern ceiling. `instr()` has no such limit, but
    // an over-long needle is a sign the subject was not a name anyway.
    if (q.length >= 4) {
      const needle = q.toLowerCase().slice(0, 50);
      // LIMIT 2, not 1 — uniqueness is the check, not an optimisation.
      //
      // Taking the first of several matching rows silently picks an event, and
      // a wrong event here puts ANOTHER FAIR'S DATES into a reply to an outside
      // business. "Riverside Fair" matching both the 2026 and 2027 editions is
      // the ordinary case, not a contrived one — this corpus is mostly annual
      // series, so near-duplicate names are the norm.
      const byName = await db
        .select({ id: events.id, slug: events.slug, name: events.name })
        .from(events)
        .where(and(isNull(events.mergedInto), sql`instr(lower(${events.name}), ${needle}) > 0`))
        .limit(2);
      if (byName.length === 1) {
        matched = {
          ...byName[0],
          url: `https://meetmeatthefair.com/events/${byName[0].slug}`,
          matchedOn: "subject",
        };
        warnings.push(
          `Event matched on SUBJECT TEXT ("${q}"), not on a URL — confirm it is the right event before quoting anything from it.`
        );
      } else if (byName.length > 1) {
        warnings.push(
          `No event chosen: the subject ("${q}") matches more than one event. Pick the right edition by hand before replying.`
        );
      }
    }
  }
  if (!matched) {
    // Tier 3 — a single distinctive token, accepted ONLY when it identifies
    // exactly one event. "SoNo" resolves; "Fair" would match hundreds and is
    // excluded by the generic-word list. Requiring uniqueness is what keeps
    // this from becoming a guess: two hits means the token did not identify
    // anything, and a wrong event here puts another fair's dates in a reply.
    const token = distinctiveToken(subjectToEventQuery(inbound.subject));
    if (token) {
      const hits = await db
        .select({ id: events.id, slug: events.slug, name: events.name })
        .from(events)
        .where(and(isNull(events.mergedInto), sql`instr(lower(${events.name}), ${token}) > 0`))
        .limit(2);
      if (hits.length === 1) {
        matched = {
          ...hits[0],
          url: `https://meetmeatthefair.com/events/${hits[0].slug}`,
          matchedOn: "subject",
        };
        warnings.push(
          `Event matched on a SINGLE TOKEN ("${token}") — the subject did not match any event name directly. Confirm it is the right event before quoting anything from it.`
        );
      } else if (hits.length > 1) {
        warnings.push(
          `No event matched; the token "${token}" is ambiguous across several events, so none was chosen.`
        );
      }
    }
  }
  if (!matched) warnings.push("No event matched from the subject or a parsed URL.");

  // ── Confidence + hand-off ───────────────────────────────────────────────
  let confidence: EventConfidence | null = null;
  let handoff: VendorInquiryBriefing["handoff"] = null;
  if (matched) {
    confidence = await readEventConfidence(db, matched.id);
    if (confidence.warning) warnings.push(confidence.warning);

    const [h] = await db
      .select({
        sourceUrl: events.sourceUrl,
        applicationUrl: events.applicationUrl,
        applicationInstructions: events.applicationInstructions,
        promoterWebsite: promoters.website,
      })
      .from(events)
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(eq(events.id, matched.id))
      .limit(1);
    handoff = h ?? null;
    if (h && !h.applicationUrl && !h.applicationInstructions) {
      // OPE-526: application_url capture still is not landing on the scrape
      // path, so its absence means "never captured", not "none exists".
      warnings.push(
        "No application_url or instructions stored — hand off the organizer's own site (source_url) rather than implying we have none."
      );
    }
  }

  // ── Vendor match ────────────────────────────────────────────────────────
  const { match: vendor, variantsTried } = await matchVendorByVariants(
    db,
    senderNameVariants(inbound.fromAddress)
  );
  if (vendor && vendor.matchedVariant === "fragment") {
    warnings.push(
      `Vendor matched only on a FRAGMENT ("${vendor.matchedOn}") — verify before treating the sender as an existing vendor.`
    );
  }

  // ── What we already sent them ───────────────────────────────────────────
  const sends = await db
    .select({
      sentAt: emailSendLedger.sentAt,
      subject: emailSendLedger.subject,
      source: emailSendLedger.source,
      status: emailSendLedger.status,
    })
    .from(emailSendLedger)
    .where(eq(emailSendLedger.inboundEmailId, inbound.id))
    .orderBy(desc(emailSendLedger.sentAt));

  return {
    inboundEmailId: inbound.id,
    matchedEvent: matched,
    confidence,
    handoff,
    vendor,
    vendorVariantsTried: variantsTried,
    priorSends: sends.map((s) => ({
      sentAt: s.sentAt ? s.sentAt.toISOString() : null,
      subject: s.subject,
      source: s.source,
      status: s.status,
    })),
    warnings,
  };
}
