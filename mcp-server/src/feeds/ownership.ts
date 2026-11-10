/**
 * OPE-1617 — may this feed URL speak for this promoter?
 *
 * Two rules, and nothing else admits a feed:
 *
 *  1. DOMAIN LIST. The feed's host is on the promoter's domain list (OPE-1614:
 *     its website domain plus `org_domains` rows, minus retired, and NOT a
 *     shared domain). `matchableDomainsFor` is the one reader of that list, so a
 *     feed check cannot drift from the claim wizard or inbound capture.
 *
 *  2. VALIDATED CONTACT. For a calendar hosted by a provider (Google Calendar,
 *     Outlook / 365, iCloud) the host proves nothing — anyone can publish a
 *     calendar there. Proof is that a VALIDATED contact of this promoter sent us
 *     the address in a message that passed aligned DMARC (`sender_auth = pass`,
 *     the same bar `record_feed_discrepancy_answer` uses), and the message
 *     actually contains the address. The inbound id is recorded on the feed.
 *
 * A provider-hosted address is NEVER admitted by rule 1 even if someone put the
 * provider's domain on an org's list (`isNonOwnableDomain` already keeps
 * google.com and outlook.com off every list; this module does not rely on it).
 */
import { and, eq, sql } from "drizzle-orm";
import { matchableDomainsFor } from "@takemetothefair/db-schema";
import { organizationalDomain } from "@takemetothefair/utils";
import { inboundEmails, promoterContacts } from "../schema.js";
import type { Db } from "../db.js";
import { normalizeCalendarUrl } from "./ical.js";

/** Calendar providers whose host proves nothing about who published the calendar. */
const CALENDAR_PROVIDER_DOMAINS = new Set([
  "google.com",
  "googleusercontent.com",
  "outlook.com",
  "office365.com",
  "office.com",
  "live.com",
  "microsoft.com",
  "icloud.com",
]);

export function isCalendarProviderUrl(url: string): boolean {
  try {
    const host = new URL(normalizeCalendarUrl(url)).hostname;
    const d = organizationalDomain(host);
    return d !== null && CALENDAR_PROVIDER_DOMAINS.has(d);
  } catch {
    return false;
  }
}

export type OwnershipResult =
  | { ok: true; basis: "domain_list"; evidence: string; inboundEmailId: null }
  | { ok: true; basis: "validated_contact"; evidence: string; inboundEmailId: string }
  | { ok: false; reason: string };

const bareAddress = (from: string) => {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
};

/** The part of a calendar address that identifies it (Google's `src`/ical path, Outlook's path). */
function calendarKey(url: string): string {
  const u = new URL(normalizeCalendarUrl(url));
  const src = u.searchParams.get("src") ?? u.searchParams.get("cid");
  return decodeURIComponent(src ?? u.pathname).toLowerCase();
}

export async function checkFeedOwnership(
  db: Db,
  args: { promoterId: string; feedUrl: string; inboundEmailId?: string | null }
): Promise<OwnershipResult> {
  let url: URL;
  try {
    url = new URL(normalizeCalendarUrl(args.feedUrl));
  } catch {
    return { ok: false, reason: "feed_url is not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, reason: `feed_url scheme ${url.protocol} is not readable` };

  if (!isCalendarProviderUrl(args.feedUrl)) {
    const host = organizationalDomain(url.hostname);
    const list = await matchableDomainsFor(db, "promoter", args.promoterId);
    if (host && list.includes(host)) {
      return {
        ok: true,
        basis: "domain_list",
        evidence: `${url.hostname} is on the promoter's domain list as ${host}`,
        inboundEmailId: null,
      };
    }
    return {
      ok: false,
      reason: `${url.hostname} is not on this promoter's domain list (${list.length ? list.join(", ") : "the list is empty"}). Add it with add_org_domain if the organizer owns it.`,
    };
  }

  // Provider-hosted: a validated contact must have sent it.
  if (!args.inboundEmailId)
    return {
      ok: false,
      reason: `${url.hostname} is a calendar provider, so its host proves nothing. Pass inbound_email_id: the message in which a validated contact of this promoter sent us the address.`,
    };
  const [mail] = await db
    .select({
      id: inboundEmails.id,
      fromAddress: inboundEmails.fromAddress,
      senderAuth: inboundEmails.senderAuth,
      bodyText: inboundEmails.bodyText,
      bodyHtml: inboundEmails.bodyHtml,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, args.inboundEmailId))
    .limit(1);
  if (!mail) return { ok: false, reason: "inbound email not found" };
  const from = bareAddress(mail.fromAddress);
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
  if (!contact) return { ok: false, reason: `${from} is not a validated contact of this promoter` };
  if (mail.senderAuth !== "pass")
    return {
      ok: false,
      reason: `the message's sender_auth is ${mail.senderAuth ?? "NULL"}, not an aligned DMARC pass`,
    };
  const key = calendarKey(args.feedUrl);
  const body = `${mail.bodyText ?? ""}\n${mail.bodyHtml ?? ""}`.toLowerCase();
  let bodyDecoded = body;
  try {
    bodyDecoded = decodeURIComponent(body.replace(/&amp;/g, "&"));
  } catch {
    // a stray % in the body: compare the raw text only
  }
  if (!key || (!body.includes(key) && !bodyDecoded.includes(key)))
    return {
      ok: false,
      reason:
        "the message does not contain this calendar address — the contact must have sent this exact calendar",
    };
  return {
    ok: true,
    basis: "validated_contact",
    evidence: `validated contact ${from} sent the address in inbound ${mail.id} (DMARC pass)`,
    inboundEmailId: mail.id,
  };
}
