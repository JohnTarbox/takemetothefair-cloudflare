/**
 * OPE-261 — recipient-list normalization, shared by BOTH outbound send paths.
 *
 * ## Why this exists
 *
 * `ALERT_EMAIL_TECHNICAL` pointed at `alert@meetmeatthefair.com`, which routes
 * straight back into our own inbound-email worker (`audit-noop`). Every stale-red
 * digest since the channel shipped was delivered — correctly, per the send
 * ledger — to a robot. No human ever saw one. The fix is to let that env var
 * name MORE THAN ONE recipient so John's Gmail gets a copy alongside the
 * (genuinely useful) machine-readable archive copy.
 *
 * ## Why splitting is REQUIRED, not cosmetic
 *
 * Both providers take a list, and neither parses a comma-separated string:
 *
 *   - Cloudflare Email Sending (`send_email` binding, the queued path):
 *     `to: string | EmailAddress | (string | EmailAddress)[]`
 *   - Resend (the direct path): `to` accepts `string[]`
 *
 * Handed `"a@x.com,b@y.com"` as a single string, each treats it as ONE address
 * — malformed — so it either bounces or silently delivers nowhere. Setting the
 * env var to a comma list without this function would make the alert channel
 * worse than the robot it replaced: today at least the archive copy lands.
 *
 * ## Why it lives in @takemetothefair/utils
 *
 * The digest does NOT go through Resend. It goes main app → `enqueueEmail` →
 * `EMAIL_JOBS` → the MCP Worker's `sendViaCfEmail`. Those are two separate
 * deploy artifacts, so a helper local to either one would leave the other
 * splitting differently (or not at all) — and the cf-email path is the one the
 * operator digest actually takes. One definition, both workers.
 */

/**
 * Split a configured recipient value into individual addresses.
 *
 * Accepts comma- OR semicolon-separated input (operators reasonably type
 * either), trims surrounding whitespace, drops empties from trailing
 * separators, and de-duplicates case-insensitively while preserving the
 * FIRST occurrence's original casing and position.
 *
 * Order is preserved and load-bearing: `alert@meetmeatthefair.com` is kept
 * first so the inbound-worker archive copy remains the primary recipient.
 *
 * @param to Raw env value, e.g. `"alert@meetmeatthefair.com, jtarboxme@gmail.com"`.
 * @returns One address per element. Empty array when nothing usable is present.
 */
export function normalizeRecipients(to: string | string[] | null | undefined): string[] {
  if (to == null) return [];
  const raw = Array.isArray(to) ? to : [to];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of raw) {
    if (typeof chunk !== "string") continue;
    for (const part of chunk.split(/[,;]/)) {
      const addr = part.trim();
      if (!addr) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
    }
  }
  return out;
}

/**
 * The canonical single-string form of a recipient list, for storage.
 *
 * The `email_send_ledger.recipient` column is one TEXT field, so a multi-
 * recipient send records the joined list rather than only the first address —
 * otherwise the ledger would under-report who was actually mailed, which is
 * precisely the class of blindness OPE-261 exists to fix.
 */
export function formatRecipientsForLedger(to: string | string[] | null | undefined): string {
  return normalizeRecipients(to).join(", ");
}

/**
 * Resolve a digest deep-link against the site base URL.
 *
 * OPE-261 §4: the stale-red digest built every link as `${base}${href}`, which
 * produced `https://meetmeatthefair.comhttps://www.bing.com/...` for the
 * IndexNow signal, whose href is already absolute. An operator alert whose
 * links don't resolve is only marginally better than one nobody receives.
 *
 * Absolute (`https://…`) and protocol-relative (`//…`) hrefs pass through
 * untouched; everything else is treated as a site-relative path.
 */
export function resolveDigestHref(baseUrl: string, href: string): string {
  const h = (href ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h) || h.startsWith("//")) return h;
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  if (!h) return base;
  return `${base}${h.startsWith("/") ? "" : "/"}${h}`;
}
