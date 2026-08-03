/**
 * OPE-297 — sources we can record but must never try to re-fetch.
 *
 * Facebook event pages are login-walled and robots-blocked. Every fetcher we
 * own bounces off them, and each bounce lands in the `fail_fetch` class that
 * OPE-199 measured at ~44% of discovery-harvest runs. An FB URL stored in
 * `events.source_url` is therefore not neutral: both rescrape routes select on
 * that column (`rescrape-descriptions` filters `isNotNull(events.source_url)`),
 * so storing it there would enrol the event in a retry loop that can only ever
 * fail, and would grow the exact noise class this lane is meant to shrink.
 *
 * So the rule is structural rather than a flag anyone has to remember:
 * an unfetchable URL is kept as provenance (citation + `source_domain`) and
 * `events.source_url` is left NULL. Nothing can select what isn't there.
 *
 * `source_domain` is still set, deliberately — the source-reliability learner
 * should get a facebook.com bucket, and that column is not a fetch input.
 */

/** Hosts whose pages we can cite but can never fetch. Match is on host only. */
const UNFETCHABLE_HOSTS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "m.facebook.com",
  "web.facebook.com",
  "l.facebook.com",
];

/**
 * True when `url` points at a source we must not enrol in any re-fetch path.
 *
 * Sub-domain aware (`www.facebook.com`, `m.facebook.com`), and deliberately
 * NOT substring-matching: a legitimate page at
 * `example.com/our-facebook-page` is perfectly fetchable and must stay so.
 */
export function isUnfetchableSource(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  return UNFETCHABLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
