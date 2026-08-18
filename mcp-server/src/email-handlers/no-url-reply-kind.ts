/**
 * OPE-453 — `reply_kind = 'no-url'` must be unreachable when a URL was parsed.
 *
 * One inbound email recorded two mutually exclusive facts: `parsed_url` held
 * `https://share.google/JAFhqhevUuDYKe2Eu`, and the sender was told
 * "We couldn't find a link to the event in your message." Both cannot be true.
 *
 * The mechanism is a deliberate override that outgrew its blast radius. GH #244
 * (2026-05-26) made the workflow trust the classifier over the URL regex:
 *
 *     const noUrlOrFreeText = !rowSnapshot.parsedUrl || isFreeText;
 *
 * That is correct for ROUTING — `pickPrimaryUrl` latches onto signature and
 * footer hrefs, so an email with full prose and a footer link should not be
 * fetched. But the branch's reply copy asserts the link does not exist, and for
 * the `isFreeText` half of that `||` there demonstrably IS one.
 *
 * The two kinds are different claims about whose mistake it was:
 *
 *   no-url          — "you didn't include a link." Fault: sender. Action: resend.
 *   unfetchable-url — "you included one, we couldn't read it." Fault: ours.
 *
 * Sending the first when the second is true is worse than sending nothing. The
 * system already knew the difference — the same branch writes
 * `extract_fail_reason: 'no-fetchable-url'` to telemetry while the customer-
 * facing sentence says the opposite. The fact was computed and stored; only the
 * copy lied.
 *
 * Choosing the kind lives here, alone, so the invariant is enforced at the
 * point of the decision rather than in a template that can be swapped.
 */

export type NoUrlFamilyKind = "no-url" | "no-url-prose-failed" | "unfetchable-url";

export interface NoUrlReplyInput {
  /** `inbound_emails.parsed_url` for this row. Non-null ⇒ we HAD a link. */
  parsedUrl: string | null | undefined;
  /** True when free-text prose extraction was attempted and came back short. */
  attemptedProse: boolean;
}

/**
 * The only sanctioned way to pick a reply kind in the no-URL family.
 *
 * Ordering matters: the `parsedUrl` test comes FIRST, so no combination of
 * later flags can route a row that carries a URL into copy which denies it.
 */
export function chooseNoUrlReplyKind(input: NoUrlReplyInput): NoUrlFamilyKind {
  const hasUrl = typeof input.parsedUrl === "string" && input.parsedUrl.trim().length > 0;
  if (hasUrl) return "unfetchable-url";
  return input.attemptedProse ? "no-url-prose-failed" : "no-url";
}

/**
 * The invariant, as a predicate. `true` means the pairing is a bug.
 *
 * Kept separate from `chooseNoUrlReplyKind` on purpose: the chooser prevents
 * the state, this detects it. A future call site that hand-rolls a kind — which
 * is exactly how this defect arose — is still caught, and the guard has
 * something to assert against in tests.
 *
 * `no-url-prose-failed` is included: its copy also tells the sender we found
 * nothing to work with, which is equally false when a URL is on the row.
 */
export function violatesNoUrlInvariant(
  replyKind: string | null | undefined,
  parsedUrl: string | null | undefined
): boolean {
  if (replyKind !== "no-url" && replyKind !== "no-url-prose-failed") return false;
  return typeof parsedUrl === "string" && parsedUrl.trim().length > 0;
}
