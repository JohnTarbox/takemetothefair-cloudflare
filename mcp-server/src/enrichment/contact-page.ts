/**
 * OPE-1689 — the promoter's own Contact page, one same-site hop.
 *
 * Promoter enrichment rendered the homepage only, so a promoter whose email or
 * phone sits one click away on /contact-us came back empty and, after OPE-1279's
 * empty-attempt threshold, EXHAUSTED with fillable fields still blank. Hand
 * check 2026-11-18: 2 of 4 exhausted gap-3 promoters (Coggeshall Farm Museum,
 * Caledonia County Fair) had a clean org-level value on that page.
 *
 * Two pure pieces, so the decision is testable without a fetch:
 *   - `findContactLink` — which ONE same-origin link to follow, if any.
 *   - `contactPageSignals` — what that page may contribute, with the precision
 *     guard a multi-person page needs (Caledonia lists 26 board members'
 *     addresses: the first mailto is a person, not the fair).
 */
import {
  isMalformedEmail,
  isPlaceholderEmail,
  normalizeExtractedEmail,
  normalizePhone,
} from "./extract.js";
import { extractPromoterSignals, type PromoterSignal } from "./promoter-extract.js";

/** Link-text / href cues, strongest first. "contact" beats "about". */
const CUES: readonly RegExp[] = [/contact/i, /get[\s_-]*in[\s_-]*touch/i, /about/i];

/**
 * The single same-origin link most likely to be the Contact page, or null.
 * Ranked by cue (contact > get in touch > about), then document order. Skips
 * mailto:/tel:/javascript:, fragments of the same page, other origins, and the
 * page itself.
 */
export function findContactLink(html: string, pageUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return null;
  }
  const self = base.origin + base.pathname.replace(/\/+$/, "");
  let best: { rank: number; url: string } | null = null;
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].trim();
    if (/^(mailto|tel|javascript|data):/i.test(href) || href.startsWith("#")) continue;
    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }
    if (target.origin !== base.origin) continue;
    target.hash = "";
    const norm = target.origin + target.pathname.replace(/\/+$/, "");
    if (norm === self) continue;
    const text = m[2].replace(/<[^>]*>/g, " ");
    const rank = CUES.findIndex((re) => re.test(target.pathname) || re.test(text));
    if (rank === -1) continue;
    if (!best || rank < best.rank) best = { rank, url: target.toString() };
    if (rank === 0) break;
  }
  return best?.url ?? null;
}

/** Local parts that name a ROLE mailbox, not a person (OPE-1689 item 2). */
const ROLE_LOCAL_PARTS =
  /^(info|office|contact|contactus|secretary|fair|admin|hello|general|mail|events?|inquiries|enquiries)$/i;

export interface ContactPageSignal extends PromoterSignal {
  /** Several distinct values on the page; this one was chosen by role/label and must not auto-apply. */
  multiple: boolean;
}

export interface ContactPageSignals {
  contactEmail?: ContactPageSignal;
  contactPhone?: ContactPageSignal;
}

function distinctEmails(html: string, bodyText: string): string[] {
  const seen = new Set<string>();
  const add = (raw: string) => {
    const e = normalizeExtractedEmail(raw.replace(/^mailto:/i, "")).toLowerCase();
    if (e && !isPlaceholderEmail(e) && !isMalformedEmail(e)) seen.add(e);
  };
  for (const m of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) add(m[1]);
  for (const m of bodyText.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) add(m[0]);
  return [...seen];
}

/** Each distinct phone with the ~60 chars of page text in front of it (its label). */
function distinctPhones(bodyText: string, html: string): { value: string; label: string }[] {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/href=["']tel:([^"']+)/gi)) {
    const v = normalizePhone(m[1]);
    if (v && !out.has(v)) out.set(v, "");
  }
  for (const m of bodyText.matchAll(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g)) {
    const v = normalizePhone(m[1]);
    if (!v) continue;
    const label = bodyText.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
    out.set(v, (out.get(v) ?? "") + " " + label);
  }
  return [...out].map(([value, label]) => ({ value, label }));
}

/**
 * What a Contact page may contribute. ONE distinct value → the ordinary
 * single-value extraction (a lone mailto/tel keeps its high-confidence method,
 * so the existing auto-apply rule decides). SEVERAL → at most one, chosen by a
 * role-style local part (info@, office@ …) or a main/office/general label, and
 * flagged `multiple` so it is never auto-applied. Neither → nothing: a
 * multi-person page with no role mailbox yields no candidate rather than a
 * stranger's address.
 */
export function contactPageSignals(
  html: string,
  pageUrl: string,
  need: { email: boolean; phone: boolean }
): ContactPageSignals {
  const ex = extractPromoterSignals(html, pageUrl);
  const body = ex.bodyText ?? "";
  const out: ContactPageSignals = {};

  if (need.email) {
    const emails = distinctEmails(html, body);
    if (emails.length <= 1 && ex.contactEmail) {
      out.contactEmail = { ...ex.contactEmail, multiple: false };
    } else if (emails.length > 1) {
      const role = emails.find((e) => ROLE_LOCAL_PARTS.test(e.split("@")[0]));
      if (role)
        out.contactEmail = { value: role, method: "mailto", confidence: 0.5, multiple: true };
    }
  }

  if (need.phone) {
    const phones = distinctPhones(body, html);
    if (phones.length <= 1 && ex.contactPhone) {
      out.contactPhone = { ...ex.contactPhone, multiple: false };
    } else if (phones.length > 1) {
      const labelled = phones.filter((p) => /\b(main|office|general)\b/i.test(p.label));
      if (labelled.length === 1) {
        out.contactPhone = {
          value: labelled[0].value,
          method: "regex",
          confidence: 0.45,
          multiple: true,
        };
      }
    }
  }
  return out;
}
