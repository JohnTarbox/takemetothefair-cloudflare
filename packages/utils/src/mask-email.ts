/**
 * OPE-1379 (HARD8) — mask an email address before it goes into a LOG line.
 *
 * Sender and recipient addresses were written verbatim into `error_logs.context`
 * (the inbound email handler, the email queue consumer, the OAuth login form)
 * and into Worker console logs. Those are diagnostic surfaces with 30-day
 * retention, not a contact store: the address itself is never what a reader of
 * a log row needs, but the DOMAIN usually is ("is this a gmail sender or a
 * fair's own domain?", "which provider rejected it?"). So the domain is kept
 * and the local part is reduced to its first character:
 *
 *     maskEmail("john.doe@example.com")  → "j***@example.com"
 *
 * Scope: log context and console lines ONLY. Columns that legitimately store an
 * address (`inbound_emails.from_address`, `email_send_ledger.recipient`,
 * `users.email`, …) keep the real value; masking there would break replies,
 * dedup and the send ledger.
 *
 * Lives in @takemetothefair/utils so both deploy artifacts (main app, MCP
 * Worker) share one format.
 */

const MASK = "***";

/**
 * Mask one address. Accepts a bare address or a display form
 * (`"Jane Doe" <jane@x.com>`), in which case the display name is dropped too —
 * it is as identifying as the local part. Anything without a usable `@` (empty,
 * null, garbage) becomes `"***"` so a malformed value can never leak through
 * unmasked.
 */
export function maskEmail(addr: string | null | undefined): string {
  if (typeof addr !== "string") return MASK;
  let s = addr.trim();
  const angle = s.match(/<([^<>]*)>/);
  if (angle) s = angle[1].trim();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return MASK;
  return `${s[0]}${MASK}@${s.slice(at + 1)}`;
}

/**
 * Mask a recipient value that may be one address, a comma/semicolon list, or an
 * array (the email-queue `to` shape). Returns one string, comma-joined, so it
 * drops straight into a template literal or a context field.
 */
export function maskEmails(to: string | readonly string[] | null | undefined): string {
  if (to == null) return MASK;
  const raw = typeof to === "string" ? [to] : [...to];
  const parts = raw
    .flatMap((chunk) => (typeof chunk === "string" ? chunk.split(/[,;]/) : []))
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return MASK;
  return parts.map(maskEmail).join(", ");
}
