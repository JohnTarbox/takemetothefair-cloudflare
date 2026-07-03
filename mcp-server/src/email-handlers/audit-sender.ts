/**
 * OPE-74 (2026-07-03) — never-actionable audit/system sender filter.
 *
 * Some inbound mail is structurally NEVER a human-actionable submission,
 * correction, or claim — yet the intent classifier misfires it into the
 * human-triage `waiting` queue as pure noise:
 *
 *   - `notify@meetmeatthefair.com` — our OWN outbound notifier (blog-mention
 *     outreach to organizers) loops its sent copies back into inbound_emails
 *     as audit copies. Five of these sat 4–5 days each in the triage queue
 *     before this filter; they were hand-terminal-stated to status='audit-noop'
 *     / extract_fail_reason='outbound-audit-copy-notify-at-meetmeatthefair'.
 *   - Generic system addresses (`noreply@`, `no-reply@`, `postmaster@`,
 *     `mailer-daemon@`) — auto-generated bounces / no-reply mail that a human
 *     can never act on.
 *
 * `isNonActionableSender` is a pure classifier used by the inbound email
 * handler (email-handler.ts) to short-circuit these at ingest: record a
 * TERMINAL `audit-noop` row for the audit trail, then return BEFORE the intent
 * classifier + workflow ever run. It is also the source of truth for the
 * belt-and-suspenders exclusion in inbound-exception-notice.ts, so a stray
 * loopback can never inflate the triage-queue count either.
 */

/**
 * Exact from-addresses (already lowercased) that are never human-actionable,
 * mapped to the categorical reason written to inbound_emails.extract_fail_reason.
 */
export const NON_ACTIONABLE_EXACT: Readonly<Record<string, string>> = {
  "notify@meetmeatthefair.com": "outbound-audit-copy-notify-at-meetmeatthefair",
};

/** Exact-address list (lowercased) — exported for the SQL exclusion in
 *  inbound-exception-notice.ts so both surfaces share one source of truth. */
export const NON_ACTIONABLE_EXACT_SENDERS: readonly string[] = Object.keys(NON_ACTIONABLE_EXACT);

/**
 * Local-part (the token before `@`, case-insensitive) values that identify a
 * generic automated/system sender. Matched by exact equality on the local part,
 * so `NoReply@anything.com` matches but a real user like `noreplyfan@x.com`
 * does not.
 */
export const NON_ACTIONABLE_LOCALPARTS: readonly string[] = [
  "noreply",
  "no-reply",
  "postmaster",
  "mailer-daemon",
];

export interface NonActionableResult {
  match: boolean;
  /** Categorical reason (stored in extract_fail_reason). Empty when no match. */
  reason: string;
}

/**
 * Classify a from-address as a never-actionable audit/system sender.
 *
 * Case-insensitive. Checks the exact-address allow-list first (specific audit
 * loopbacks), then the generic system local-parts. Null / empty / malformed
 * input is treated as no-match (fail-open — the normal pipeline still runs).
 */
export function isNonActionableSender(fromAddr: string | null | undefined): NonActionableResult {
  const addr = (fromAddr ?? "").trim().toLowerCase();
  if (!addr) return { match: false, reason: "" };

  // Exact audit-loopback addresses.
  const exactReason = NON_ACTIONABLE_EXACT[addr];
  if (exactReason) return { match: true, reason: exactReason };

  // Generic system local-part. When there's no `@`, treat the whole token as
  // the local part (covers a bare `MAILER-DAEMON`).
  const at = addr.indexOf("@");
  const localPart = at >= 0 ? addr.slice(0, at) : addr;
  if (NON_ACTIONABLE_LOCALPARTS.includes(localPart)) {
    return { match: true, reason: `system-sender-${localPart}` };
  }

  return { match: false, reason: "" };
}
