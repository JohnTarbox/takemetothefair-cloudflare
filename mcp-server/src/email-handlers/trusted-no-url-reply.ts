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
    replyParams: {
      eventName: input.matched.name,
      eventUrl: `${PUBLIC_HOST}/events/${input.matched.slug}`,
      ...(input.applied.length > 0 ? { appliedFields: plainFieldList(input.applied) } : {}),
      ...(input.staged ? { staged: true } : {}),
    },
  };
}
