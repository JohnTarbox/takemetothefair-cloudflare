/**
 * OPE-1630 item 3 — the /admin/feed-review state filter. Its own module because a
 * Next page may export only its reserved names (a helper exported from page.tsx
 * fails the build's page-type check).
 */
import { REVIEW_STATES, type ReviewState } from "./review";

/** The states a reviewer can filter to; "all" is every state. Unknown → the queue. */
export function parseReviewState(raw: string | undefined): ReviewState | "all" {
  if (raw === "all") return "all";
  return REVIEW_STATES.includes(raw as ReviewState) ? (raw as ReviewState) : "awaiting_review";
}
