/**
 * OPE-265 — which outbound link the event page's primary CTA points at.
 *
 * The CTA used to render ONLY when `ticket_url` was set, and on 2026-10-01 that
 * was 48 of 512 upcoming APPROVED events. Every high-traffic event page with
 * zero `outbound_ticket_click` in the prior 28 days (Feast of the Three Saints,
 * Brimfield, Olde Mistick Garlic Festival …) had a NULL `ticket_url` — so the
 * page had no button to click, which is what the conversion KPI was measuring.
 *
 * John approved (2026-09-30) a CTA experiment on exactly those pages, judged by
 * click lift. When there is no ticket URL we fall back to the event's
 * `source_url` — the organizer page we found it on — but only after vetting it,
 * because `source_url` is a provenance field, not a fair-goer link: it can be a
 * vendor-application form, a click-tracker, or our own domain.
 *
 * `ctaSource` rides on the click beacon so the experiment's clicks can be told
 * apart from ticket-URL clicks in `analytics_events`.
 */

import { SITE_URL } from "@takemetothefair/constants";
import { extractDomain } from "@/lib/url-classification";

export type EventCtaSource = "ticket_url" | "source_url";

export interface EventCta {
  url: string;
  ctaSource: EventCtaSource;
  label: string;
}

const OWN_DOMAIN = extractDomain(SITE_URL);

/**
 * Hosts whose URL is a redirect or a share wrapper rather than the organizer's
 * page — a CTA through one of them lands somewhere we have not seen.
 */
const NON_DESTINATION_HOSTS = new Set([
  "share.google",
  "goo.gl",
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "lnkd.in",
  "l.facebook.com",
  "list-manage.com",
  "mailchi.mp",
  "click.mailchimp.com",
  "r20.rs6.net",
  // A Google Form is almost always a vendor or volunteer sign-up.
  "forms.gle",
]);

/**
 * A path that addresses vendors, not visitors. Shaker Hill Apple Festival's
 * `source_url` is its vendor-application page; a "Tickets & Info" button there
 * would send a fair-goer to a booth form.
 */
const VENDOR_PATH = /(vendor|exhibitor|applica|apply|crafter|booth)/i;

/**
 * Whether a `source_url` is safe to show a fair-goer as the event's website.
 * Shape-only; the domain-classification gate (aggregators) runs in the caller.
 */
export function isFairgoerSourceUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const domain = extractDomain(trimmed);
  if (!domain) return false;
  if (domain === OWN_DOMAIN || domain.endsWith(`.${OWN_DOMAIN}`)) return false;
  for (const host of NON_DESTINATION_HOSTS) {
    if (domain === host || domain.endsWith(`.${host}`)) return false;
  }
  // google.com/url?q=… is a redirect wrapper; sites.google.com is a real
  // organizer host and must stay allowed, so this is path-scoped.
  if (domain === "google.com" && parsed.pathname.startsWith("/url")) return false;
  if (VENDOR_PATH.test(parsed.pathname)) return false;
  return true;
}

/**
 * Pick the CTA. `ticket_url` always wins and keeps its existing label, so the
 * pages that already convert are unchanged — the experiment is only the
 * fallback. `vettedSourceUrl` must already have passed `isFairgoerSourceUrl`
 * AND the classification gate; pass null otherwise.
 */
export function pickEventCta(input: {
  ticketUrl: string | null | undefined;
  vettedSourceUrl: string | null | undefined;
  ticketPriceMaxCents: number | null | undefined;
}): EventCta | null {
  const ticketUrl = input.ticketUrl?.trim();
  if (ticketUrl) {
    return { url: ticketUrl, ctaSource: "ticket_url", label: "Event Website" };
  }
  const sourceUrl = input.vettedSourceUrl?.trim();
  if (!sourceUrl) return null;
  // Only say "Tickets" when we know admission is charged. A free or
  // unknown-price event gets a label that promises no more than a website.
  const paid = (input.ticketPriceMaxCents ?? 0) > 0;
  return {
    url: sourceUrl,
    ctaSource: "source_url",
    label: paid ? "Tickets & Info" : "Official Event Website",
  };
}
