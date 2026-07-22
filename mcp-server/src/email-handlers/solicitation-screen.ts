/**
 * OPE-278 — deterministic list-broker / attendee-list solicitation screen.
 *
 * The AI intent classifier mislabeled a B2B "attendee list for sale"
 * solicitation as `new_event` (inbound_emails c3198c13, "Complete Attendee
 * Information for CraftFest Cotuit 2026"), which ran the extraction pipeline
 * and created a duplicate PENDING event (`craftfest-cotuit-2026-2`). Nothing in
 * such an email submits an event — it tries to sell us contact data ABOUT one.
 *
 * This is a cheap, deterministic backstop layered on top of the AI classifier:
 * strong textual tells (an offer to provide an attendee/contact LIST, plus a
 * commercial ask or a catalog of contact fields) force the message to `spam`,
 * which the entrypoint silently quarantines BEFORE any workflow / event
 * creation. It is tuned to be specific — a genuine event submission carries
 * none of these — and the quarantine is recoverable: the inbound_emails row is
 * retained for audit and an operator can reclassify it.
 */

/**
 * "We have a LIST" phrases — the core of a data-broker pitch. A legitimate
 * event submission does not describe itself as an available list.
 */
const LIST_PHRASES: RegExp[] = [
  /\battendee[s]?\s+(list|information|data|database|contacts?)\b/i,
  /\bpre[-\s]?registered\b/i,
  /\blist\s+is\s+available\b/i,
  /\blist\s+includes\b/i,
  /\b(mailing|email|e-mail|contact|prospect|subscriber|delegate|visitor|exhibitor)\s+list\b/i,
  /\bdata\s?base?\s+(is\s+)?available\b/i,
  /\bopt[-\s]?in\s+list\b/i,
];

/** Commercial ask — the "for money" half of the pitch. */
const COMMERCIAL_PHRASES: RegExp[] = [
  /\bexclusive\s+(fee|rate|price|pricing|offer)\b/i,
  /\bfor\s+a\s+(small\s+)?fee\b/i,
  /\b(purchase|buy|acquire|rent|lease)\s+the\s+(list|data|database)\b/i,
  /\bper\s+(lead|contact|record)\b/i,
  /\bpricing\s+(for|of)\s+the\s+(list|data)\b/i,
];

/**
 * Catalog of contact fields the broker is offering — a legit event email does
 * not enumerate "email address / mobile number / title/designation" as a
 * deliverable.
 */
const CONTACT_FIELD_PHRASES: RegExp[] = [
  /\bemail\s+address(es)?\b/i,
  /\bmobile\s+number\b/i,
  /\bphone\s+number\b/i,
  /\btitle\s*\/\s*designation\b/i,
  /\bcompany\s+title\b/i,
  /\bjob\s+title\b/i,
  /\burl\s*\/\s*website\b/i,
];

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
}

/**
 * True when the subject+body reads as a list-broker / attendee-list
 * solicitation. Gate: at least one "we have a list" signal, PLUS corroboration
 * — either a second list signal, a commercial ask, or a catalog of ≥2 contact
 * fields. Requiring corroboration keeps a lone incidental phrase (a footer
 * "email address", a stray "mailing list" mention) from tripping it.
 */
export function isListBrokerSolicitation(
  subject: string | null | undefined,
  body: string | null | undefined
): boolean {
  const text = `${subject ?? ""}\n${body ?? ""}`;
  const listSignals = countMatches(text, LIST_PHRASES);
  if (listSignals === 0) return false;
  const commercial = COMMERCIAL_PHRASES.some((re) => re.test(text));
  const contactFields = countMatches(text, CONTACT_FIELD_PHRASES);
  return listSignals >= 2 || commercial || contactFields >= 2;
}
