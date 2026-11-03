/**
 * OPE-1265 — lists@ / lists+<promoter-slug>@ handler.
 *
 * John's ruling (2026-10-01): MMATF subscribes its own address to promoter
 * mailing lists, so newsletters arrive directly — DKIM-signed by the
 * promoter's ESP — instead of through a person's forward. This handler is the
 * receiving side. It records, attributes and HOLDS; it never replies.
 *
 *  - Attribution: a plus-tag that is a promoter slug attributes the mail to that
 *    promoter with basis `subscription-address`. That outranks any sender-domain
 *    match (OPE-1264), because ESPs send from shared domains. No tag, or an
 *    unknown one → stored `unattributed`.
 *  - Confirmation emails (double opt-in) are recognised and their confirm link
 *    is extracted onto the arrival and the registry row. The link is NEVER
 *    fetched here: auto-confirming means the Worker following a URL supplied by
 *    inbound mail (the OPE-992 SSRF surface) and is a separate decision for John.
 *  - Shared or sold list: an issue arriving on a subscription from a sender
 *    domain that subscription has never seen is recorded (`sender_mismatch`),
 *    never acted on.
 *  - Disposition `held`: the newsletter lane that processes issues is OPE-1264.
 *    Until it ships, arrivals park here, replayable, and never touch the submit
 *    lane.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { promoterListArrivals, promoterListSubscriptions, promoters } from "../schema.js";
import { parsePlusSegment } from "../email-intents.js";
import { unsafeSlug } from "@takemetothefair/utils";
import type { HandlerFn, HandlerResult } from "./types.js";

/** Double-opt-in wording. Deliberately phrase-shaped: a newsletter that says
 *  "confirm your booth" must not read as a subscription confirmation. */
const CONFIRMATION_RE =
  /\b(confirm (your |my )?(subscription|e-?mail( address)?|sign-?up)|please confirm|verify (your )?e-?mail( address)?|click (the link |the button |here )?(below )?to confirm|activate your subscription|double opt-?in)\b/i;

/** A link whose path or query reads like a subscription confirmation. */
const CONFIRM_LINK_RE = /(confirm|verify|opt-?in|activate|subscribe)/i;

/** First confirmation-shaped URL in the HTML hrefs, then the text body. */
export function extractConfirmUrl(html: string | null, text: string | null): string | null {
  const candidates: string[] = [];
  for (const m of (html ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)) candidates.push(m[1]);
  for (const m of (text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) candidates.push(m[0]);
  for (const raw of candidates) {
    const u = raw.replace(/&amp;/g, "&").trim();
    if (!/^https?:\/\//i.test(u)) continue;
    if (/unsubscribe/i.test(u)) continue; // the footer link is the opposite act
    if (CONFIRM_LINK_RE.test(u)) return u;
  }
  return null;
}

export function looksLikeConfirmation(subject: string | null, body: string | null): boolean {
  return CONFIRMATION_RE.test(`${subject ?? ""}\n${body ?? ""}`);
}

function domainOf(address: string | null): string | null {
  const at = (address ?? "").lastIndexOf("@");
  return at < 0
    ? null
    : (address ?? "")
        .slice(at + 1)
        .toLowerCase()
        .trim() || null;
}

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const db = getDb(env.DB);
  const now = new Date();
  const toAddress = (row.toAddress ?? "").toLowerCase().trim();
  const plusTag = parsePlusSegment(toAddress);
  const senderDomain = domainOf(row.fromAddress);

  const [promoter] = plusTag
    ? await db
        .select({ id: promoters.id })
        .from(promoters)
        .where(eq(promoters.slug, unsafeSlug(plusTag)))
        .limit(1)
    : [];

  const [subscription] = promoter
    ? await db
        .select()
        .from(promoterListSubscriptions)
        .where(eq(promoterListSubscriptions.promoterId, promoter.id))
        .orderBy(sql`${promoterListSubscriptions.address} = ${toAddress} DESC`)
        .limit(1)
    : [];

  const body = row.bodyText ?? row.bodyTextExcerpt ?? null;
  // A confirmation is the FIRST mail after we asked; once a list is confirmed,
  // an issue that happens to say "please confirm your RSVP" is still an issue.
  const awaitingConfirmation = !subscription || subscription.status === "requested";
  const isConfirmation = awaitingConfirmation && looksLikeConfirmation(row.subject ?? null, body);
  const confirmUrl = isConfirmation ? extractConfirmUrl(row.bodyHtml ?? null, body) : null;

  // Shared / sold list: a sender domain this subscription has never seen.
  let senderMismatch = 0;
  if (subscription && senderDomain && !isConfirmation) {
    const seen = await db
      .select({ d: promoterListArrivals.senderDomain })
      .from(promoterListArrivals)
      .where(eq(promoterListArrivals.subscriptionId, subscription.id))
      .groupBy(promoterListArrivals.senderDomain);
    if (seen.length > 0 && !seen.some((s) => s.d === senderDomain)) senderMismatch = 1;
  }

  await db
    .insert(promoterListArrivals)
    .values({
      inboundEmailId: row.id,
      promoterId: promoter?.id ?? null,
      matchBasis: promoter ? "subscription-address" : "unattributed",
      plusTag,
      subscriptionId: subscription?.id ?? null,
      kind: isConfirmation ? "confirmation" : "issue",
      confirmUrl,
      senderDomain,
      senderMismatch,
      createdAt: now,
    })
    .onConflictDoNothing();

  if (subscription) {
    if (isConfirmation) {
      await db
        .update(promoterListSubscriptions)
        .set({ confirmUrl: confirmUrl ?? subscription.confirmUrl, updatedAt: now })
        .where(eq(promoterListSubscriptions.id, subscription.id));
    } else {
      await db
        .update(promoterListSubscriptions)
        .set({
          lastReceivedAt: now,
          issueCount: sql`${promoterListSubscriptions.issueCount} + 1`,
          // The first real issue after a confirmation is the list going live.
          status: subscription.status === "confirmed" ? "active" : subscription.status,
          updatedAt: now,
        })
        .where(
          and(
            eq(promoterListSubscriptions.id, subscription.id),
            eq(promoterListSubscriptions.promoterId, subscription.promoterId)
          )
        );
    }
  }

  // Never a reply, whatever the mail says (OPE-1265 scope 5). `held` until the
  // OPE-1264 newsletter lane exists to process it.
  return {
    replyKind: null,
    status: "held",
    resultingEventId: null,
  };
};
