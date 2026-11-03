/**
 * OPE-1559 — the /list-your-event landing copy, APPROVED BY JOHN on
 * 2026-11-02 (OPE-1559 comment e9ac732f: "Approve all four as written").
 * Reproduced verbatim; change it only with a fresh approval, since it is
 * customer-facing SERP and FAQ copy (OPE-6 gate).
 *
 * One module for the strings so the page metadata, the visible FAQ and the
 * FAQPage JSON-LD cannot drift apart (Google requires the JSON-LD to match the
 * visible text).
 */
import { STATES, STATE_CODES, type StateCode } from "@/lib/states";
import type { FaqItem } from "@/lib/event-faq";

export const LIST_YOUR_EVENT_TITLE =
  "List Your Fair or Festival Free — New England | Meet Me at the Fair";

/** The description, for New England or for one state ("same as above, with the
 *  state name"). */
export function listYourEventDescription(placeName = "New England"): string {
  return `Running a fair, festival or craft show in ${placeName}? Add it to Meet Me at the Fair free — one short form, no account. Every listing is reviewed by a person.`;
}

export function listYourEventStateTitle(stateName: string): string {
  return `List Your Craft Fair or Festival Free in ${stateName} | Meet Me at the Fair`;
}

/**
 * The FAQPage block. Deliberately makes NO time promise — the OPE-412
 * measurement had review at 0/6 within 48h.
 */
export const LIST_YOUR_EVENT_FAQ: readonly FaqItem[] = [
  {
    question: "Is it really free?",
    answer: "Yes. Listing an event costs nothing, and you don't need an account.",
  },
  {
    question: "When will my event show up?",
    answer:
      "A person checks every listing before it goes live. You'll get a receipt by email when you submit.",
  },
  {
    question: "What can I list?",
    answer:
      "Fairs, festivals, craft shows, farmers markets, and school, church and community fairs: anything in New England that's open to the public.",
  },
  {
    question: "Can I change it later?",
    answer: "Yes. Reply to your receipt email with the change.",
  },
];

/** The six per-state landing slugs, from the canonical state table. */
export const LIST_YOUR_EVENT_STATE_SLUGS: readonly string[] = STATE_CODES.map(
  (c) => STATES[c].slug
);

export function stateCodeForListSlug(slug: string): StateCode | null {
  const code = STATE_CODES.find((c) => STATES[c].slug === slug);
  return code ?? null;
}

/** Every indexable landing path — the sitemap reads this, so a new state
 *  row reaches the sitemap without a second edit. */
export const LIST_YOUR_EVENT_PATHS: readonly string[] = [
  "/list-your-event",
  ...LIST_YOUR_EVENT_STATE_SLUGS.map((s) => `/list-your-event/${s}`),
];
