/**
 * Host denylist for URLs that should never be treated as an event's own page.
 *
 * Surfaced by analyst K1 (2026-05-29 PM). A forwarded Mailchimp newsletter
 * carried a `https://us.list-manage.com/...` click-tracking redirect AS
 * the first http(s):// URL in the body. The inbound-email workflow's URL
 * grabbers (pickPrimaryUrl / extractAllUrls in email-handler.ts) took
 * that as `parsedUrl`, the fetch-the-URL branch ran against the Mailchimp
 * redirect/registration page, the AI extractor returned zero events, and
 * the sender got an `extract-failed` reply even though her body had the
 * event name + date in plain text.
 *
 * The fix: filter known tracking/redirect hosts before they become
 * `parsedUrl`. With no usable URL, the message routes to the free-text
 * branch (`submitFreeTextExtract`) and the name/date extract cleanly
 * from the body.
 *
 * NOT in scope here: HEAD-following redirects to discover what tracking
 * URLs actually resolve to. Too expensive to do on every inbound email
 * and the body usually carries the real URL alongside the tracker.
 */

/**
 * Exact hostname matches. Lowercased on lookup so callers don't have to
 * normalize.
 */
export const URL_DENYLIST_HOSTS: ReadonlySet<string> = new Set([
  // Mailchimp click-tracker (the K1 case)
  "list-manage.com",
  "mailchi.mp",
  // ESP click-trackers — common in forwarded newsletters
  "click.icptrack.com",
  "click.hubspot.com",
  "click.email.eventbrite.com",
  "links.linkedin.com",
  "email.constantcontact.com",
  "trk.klclick.com",
  // Government bulk-mailer (GovDelivery) click-tracker
  "lnks.gd",
  // URL shorteners — almost never the event's own page
  "ow.ly",
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "u.click",
]);

/**
 * Subdomain wildcards — hostname ending in any of these suffixes matches.
 * Use sparingly; over-broad suffix matches risk blocking legitimate
 * organizer pages on shared hosts.
 */
export const URL_DENYLIST_SUFFIXES: ReadonlyArray<string> = [
  // Mailchimp uses *.list-manage.com (e.g. us8.list-manage.com)
  ".list-manage.com",
  // SendGrid + Mailgun click-trackers
  ".sendgrid.net",
  ".mailgun.org",
];

/**
 * Returns true if `url` is on the denylist (exact host match or suffix
 * match). Returns false for unparseable URLs — the caller's downstream
 * `cleanUrl` validation already rejects those; we should not double-
 * filter unparseable inputs.
 */
export function isDenylistedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (URL_DENYLIST_HOSTS.has(host)) return true;
  return URL_DENYLIST_SUFFIXES.some((suf) => host.endsWith(suf));
}
