/**
 * OPE-1505 Ask 4 — a trusted sender (John, Carolyn) is never asked to reply with
 * the name, start date and location of an event they just forwarded.
 *
 * John approved both replies on 2026-11-10. They replace `no-url-prose-failed`
 * only, and only for a trusted sender. Everyone else keeps today's reply.
 */
import type { ReplyKind, ReplyParams } from "./types.js";

const PUBLIC_HOST = "https://meetmeatthefair.com";

/** "ticket_price_min_cents", "parking_notes" → "ticket price", "parking notes". */
export function plainFieldName(field: string): string {
  return field
    .replace(/_cents$/, "")
    .replace(/_(min|max)$/, "")
    .replace(/_url$/, "_link")
    .replace(/_/g, " ");
}

/** A comma list in plain words. A min/max pair reads as one field. */
export function plainFieldList(fields: readonly string[]): string {
  return [...new Set(fields.map(plainFieldName))].join(", ");
}

/** The listing-match reply's params. Shared by both paths that use it. */
export function trustedListingParams(input: {
  name: string;
  url: string;
  applied: readonly string[];
  staged: boolean;
}): ReplyParams {
  return {
    eventName: input.name,
    eventUrl: input.url,
    ...(input.applied.length > 0 ? { appliedFields: plainFieldList(input.applied) } : {}),
    ...(input.staged ? { staged: true } : {}),
  };
}

/**
 * OPE-1506 — the reply on a trusted sender's single-high venue+date match. It
 * needs a link we may send, so a listing that is not public returns null and
 * the caller keeps `already-exists`.
 */
export function chooseTrustedVenueDateReply(input: {
  senderTrust: string;
  matchType: string | null;
  listingUrl: string | null;
  name: string;
  applied: readonly string[];
  staged: boolean;
}): { replyKind: ReplyKind; replyParams: ReplyParams } | null {
  if (input.senderTrust !== "trusted" || input.matchType !== "venue_date" || !input.listingUrl) {
    return null;
  }
  return {
    replyKind: "trusted-listing-match",
    replyParams: trustedListingParams({
      name: input.name,
      url: input.listingUrl,
      applied: input.applied,
      staged: input.staged,
    }),
  };
}

export function chooseTrustedNoUrlReply(input: {
  replyKind: ReplyKind;
  trusted: boolean;
  matched: { name: string; slug: string } | null;
  applied: readonly string[];
  staged: boolean;
}): { replyKind: ReplyKind; replyParams: ReplyParams } | null {
  if (!input.trusted || input.replyKind !== "no-url-prose-failed") return null;
  if (!input.matched) return { replyKind: "trusted-no-match", replyParams: {} };
  return {
    replyKind: "trusted-listing-match",
    replyParams: trustedListingParams({
      name: input.matched.name,
      url: `${PUBLIC_HOST}/events/${input.matched.slug}`,
      applied: input.applied,
      staged: input.staged,
    }),
  };
}
