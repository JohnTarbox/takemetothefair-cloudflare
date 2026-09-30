/**
 * OPE-986 — refuse email addresses whose DOMAIN cannot receive mail, at the
 * moment the person is still on the form and can fix it.
 *
 * ── The case ────────────────────────────────────────────────────────────────
 * On 2026-09-13 a crafter registered twice in eight minutes. The second address
 * was `sanzaarts@gmail.vom`. The verification email hard-bounced 16 seconds
 * after the send ("unknown public suffix: gmail.vom"), the address went onto
 * the suppression list, and the account could never be verified. Nothing on
 * the form objected: `z.string().email()` checks SHAPE, and `gmail.vom` is a
 * perfectly well-shaped domain.
 *
 * ── Deliberately NOT a TLD allow-list ───────────────────────────────────────
 * There are well over a thousand live TLDs (`.shop`, `.farm`, `.studio` …) and
 * an allow-list goes stale the week a vendor on a new one signs up. So this
 * rejects only what is KNOWN to be a typo:
 *
 *   1. a TLD that is not alphabetic and ≥ 2 characters (IDN `xn--` allowed);
 *   2. a small blacklist of keyboard-slip TLDs that are not delegated
 *      (`vom`, `con`, `cmo` …) — each maps to the TLD it was meant to be;
 *   3. misspellings of the few mailbox providers most people here use
 *      (`gmial.com`, `hotmial.com`, `yaho.com` …).
 *
 * ⚠️ One entry is a real ccTLD: `cm` is Cameroon. It is blocked on purpose — a
 * `gmail.cm` / `yahoo.cm` slip is far likelier on this site than a Cameroonian
 * mailbox — and it is the only such entry. Do not add real TLDs (`co`, `om`,
 * `ca` …) to TLD_TYPOS; a provider-specific slip like `gmail.co` belongs in
 * DOMAIN_TYPOS, where it cannot touch anyone else's domain.
 *
 * Pure and dependency-free so the register form and the register API run the
 * same check.
 */

/** Keyboard-slip TLDs → the TLD meant. None is a delegated TLD except `cm`. */
const TLD_TYPOS: Record<string, string> = {
  vom: "com",
  con: "com",
  cmo: "com",
  ocm: "com",
  comm: "com",
  coom: "com",
  cpm: "com",
  xom: "com",
  cim: "com",
  comn: "com",
  cm: "com",
  ogr: "org",
  orgg: "org",
  nett: "net",
  nte: "net",
};

/** Misspelled provider labels → the provider's real label. */
const PROVIDER_LABEL_TYPOS: Record<string, string> = {
  gmial: "gmail",
  gmai: "gmail",
  gmal: "gmail",
  gamil: "gmail",
  gnail: "gmail",
  gmaill: "gmail",
  gmali: "gmail",
  gmil: "gmail",
  gmsil: "gmail",
  gimail: "gmail",
  hotmial: "hotmail",
  hotmal: "hotmail",
  hotmai: "hotmail",
  homail: "hotmail",
  hotmali: "hotmail",
  hotmil: "hotmail",
  hotamil: "hotmail",
  yaho: "yahoo",
  yahooo: "yahoo",
  yhoo: "yahoo",
  yahho: "yahoo",
  yaoo: "yahoo",
  outlok: "outlook",
  oulook: "outlook",
  otlook: "outlook",
  outloo: "outlook",
  iclod: "icloud",
  icoud: "icloud",
  iclould: "icloud",
  comcat: "comcast",
  comcst: "comcast",
};

/**
 * Whole-domain slips that are only wrong FOR THAT PROVIDER. `.co` is a real
 * TLD, so it cannot go in TLD_TYPOS — but no one's Gmail lives at `gmail.co`.
 */
const DOMAIN_TYPOS: Record<string, string> = {
  "gmail.co": "gmail.com",
  "gmail.om": "gmail.com",
  "gmail.cm": "gmail.com",
  "yahoo.co": "yahoo.com",
  "hotmail.co": "hotmail.com",
  "outlook.co": "outlook.com",
  "icloud.co": "icloud.com",
  "aol.co": "aol.com",
};

export type EmailDomainVerdict =
  | { ok: true }
  | {
      ok: false;
      /** The corrected full address, when the slip is a known one. */
      suggestion: string | null;
      message: string;
    };

export function checkEmailDomain(rawEmail: string): EmailDomainVerdict {
  const email = rawEmail.trim();
  const at = email.lastIndexOf("@");
  // Shape is `z.string().email()`'s job; this only judges a domain it can see.
  if (at <= 0 || at === email.length - 1) return { ok: true };

  const local = email.slice(0, at);
  const domain = email
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  const labels = domain.split(".");
  if (labels.length < 2) return { ok: true };

  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) {
    return {
      ok: false,
      suggestion: null,
      message: `Check your email address — "${domain}" is not a valid email domain.`,
    };
  }

  let fixed = DOMAIN_TYPOS[domain] ?? null;
  if (!fixed) {
    const fixedLabels = [...labels];
    const label = fixedLabels[fixedLabels.length - 2];
    let changed = false;
    if (PROVIDER_LABEL_TYPOS[label]) {
      fixedLabels[fixedLabels.length - 2] = PROVIDER_LABEL_TYPOS[label];
      changed = true;
    }
    if (TLD_TYPOS[tld]) {
      fixedLabels[fixedLabels.length - 1] = TLD_TYPOS[tld];
      changed = true;
    }
    if (changed) fixed = DOMAIN_TYPOS[fixedLabels.join(".")] ?? fixedLabels.join(".");
  }

  if (!fixed) return { ok: true };
  const suggestion = `${local}@${fixed}`;
  return { ok: false, suggestion, message: `Did you mean ${suggestion}?` };
}
