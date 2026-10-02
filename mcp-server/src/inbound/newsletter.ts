/**
 * OPE-1264 — recognise a promoter's newsletter, and say whose it is.
 *
 * A newsletter is not an event submission: it is a multi-item bulletin with
 * every link wrapped in an ESP click-tracker. Through the submit lane, 11
 * forwarded newsletters produced six different reply kinds, eight event rows,
 * six of them rejected. This module is the classification + attribution half
 * (scopes 1, 2): the itemizer that disposes of each dated mention against the
 * promoter's events (scopes 3, 4) is the next increment.
 *
 * ## The rule, measured before shipping
 *
 * A newsletter carries an ESP marker (a click-tracker host, or an ESP's own
 * footer) AND at least one bulk-mail marker (view-in-browser, unsubscribe,
 * preferences, "you are receiving this"). Measured on prod D1, 2026-10-02,
 * over all 225 emails the two trusted forwarders sent since 2026-06-01: it
 * matches all 11 newsletters in OPE-1264's baseline, plus one more that IS a
 * newsletter (`0cb048f4`, a vendor's Constant Contact send), and nothing else.
 * Joyce's Craft Shows sends through Brevo (`sendibm3.com`, "Preview online"),
 * which is why those markers are listed — the first draft missed it.
 *
 * An ESP marker is required on purpose: "unsubscribe" alone appears in plenty
 * of personal mail threads that quote a list footer.
 */

/** Click-tracker / sending hosts — substrings of the lowercased body. */
const ESP_HOST_MARKERS = [
  "list-manage.com", // Mailchimp
  "mailchi.mp",
  "ccsend.com", // Constant Contact
  "rs6.net",
  "constantcontact",
  "mlsend", // MailerLite
  "mailerlite",
  "sendibm", // Brevo / Sendinblue
  "sendinblue",
  "brevo.com",
  "icptrack", // iContact
  "sendgrid.net",
  "mailgun",
  "klclick", // Klaviyo
  "hubspotlinks",
] as const;

/** An ESP's own footer line, for sends whose links did not survive a forward. */
const ESP_FOOTER_MARKERS = [
  "constant contact data notice",
  "sent via mailchimp",
  "intuit mailchimp",
  "powered by mailerlite",
] as const;

const BULK_MARKERS: Record<string, readonly string[]> = {
  browser: [
    "view this email in your browser",
    "view in browser",
    "view it in your browser",
    "view this email online",
    "view as webpage",
    "preview online",
  ],
  unsubscribe: ["unsubscribe"],
  preferences: [
    "update your preferences",
    "update preferences",
    "manage preferences",
    "update profile",
    "manage your subscription",
    "update subscription preferences",
  ],
  receiving: [
    "you are receiving this",
    "you're receiving this",
    "you received this email",
    "you are subscribed",
    "why did i get this",
  ],
};

export interface NewsletterVerdict {
  isNewsletter: boolean;
  /** Every marker that fired, e.g. ["esp:list-manage.com", "bulk:unsubscribe"]. */
  markers: string[];
}

export function detectNewsletter(text: string | null, html: string | null): NewsletterVerdict {
  const t = `${text ?? ""} ${html ?? ""}`.toLowerCase();
  const markers: string[] = [];
  for (const m of ESP_HOST_MARKERS) if (t.includes(m)) markers.push(`esp:${m}`);
  for (const m of ESP_FOOTER_MARKERS) if (t.includes(m)) markers.push(`esp-footer:${m}`);
  const esp = markers.length > 0;
  let bulk = 0;
  for (const [name, phrases] of Object.entries(BULK_MARKERS)) {
    if (phrases.some((p) => t.includes(p))) {
      markers.push(`bulk:${name}`);
      bulk++;
    }
  }
  return { isNewsletter: esp && bulk >= 1, markers };
}

/** Registrable domain (last two labels) of a host or URL; null if unparseable. */
function registrableOf(hostOrUrl: string | null | undefined): string | null {
  if (!hostOrUrl) return null;
  let host = hostOrUrl.trim().toLowerCase();
  try {
    if (host.includes("/"))
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  const parts = host
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : null;
}

/** ESP sending domains are shared by every customer: never evidence of who. */
const SHARED_SENDER_DOMAINS = new Set([
  "ccsend.com",
  "mailchimp.com",
  "mcsv.net",
  "mailerlite.com",
  "mlsend.com",
  "sendinblue.com",
  "brevo.com",
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
]);

export type NewsletterMatchBasis =
  | "subscription-address"
  | "sender-domain"
  | "contact-email"
  | "footer-name"
  | "unmatched";

export interface PromoterRow {
  id: string;
  companyName: string;
  website: string | null;
  contactEmail: string | null;
}

/**
 * Scope 2 — whose newsletter is it. In order of strength:
 *   subscription-address — the lists+<slug>@ tag (OPE-1265), resolved upstream;
 *   contact-email        — the original sender IS the promoter's contact email;
 *   sender-domain        — the sender's domain is the promoter website's domain
 *                          (never a shared ESP or webmail domain);
 *   footer-name          — exactly ONE promoter's full name appears in the
 *                          footer (the last 2,000 characters). Two or more →
 *                          unmatched: a wrong attribution is worse than none.
 * Never creates a promoter.
 */
export function attributeNewsletter(
  input: {
    senderAddress: string | null;
    text: string | null;
    subscriptionPromoterId?: string | null;
  },
  promoterRows: PromoterRow[]
): { promoterId: string | null; basis: NewsletterMatchBasis } {
  if (input.subscriptionPromoterId) {
    return { promoterId: input.subscriptionPromoterId, basis: "subscription-address" };
  }
  const sender = (input.senderAddress ?? "").toLowerCase().trim();
  if (sender) {
    const byEmail = promoterRows.filter(
      (p) => (p.contactEmail ?? "").toLowerCase().trim() === sender
    );
    if (byEmail.length === 1) return { promoterId: byEmail[0].id, basis: "contact-email" };

    const senderDomain = registrableOf(sender.split("@")[1] ?? null);
    if (senderDomain && !SHARED_SENDER_DOMAINS.has(senderDomain)) {
      const byDomain = promoterRows.filter((p) => registrableOf(p.website) === senderDomain);
      if (byDomain.length === 1) return { promoterId: byDomain[0].id, basis: "sender-domain" };
    }
  }

  const footer = (input.text ?? "").slice(-2000).toLowerCase();
  const byName = promoterRows.filter((p) => {
    const name = p.companyName.trim().toLowerCase();
    return name.length >= 10 && name.includes(" ") && footer.includes(name);
  });
  if (byName.length === 1) return { promoterId: byName[0].id, basis: "footer-name" };

  return { promoterId: null, basis: "unmatched" };
}
