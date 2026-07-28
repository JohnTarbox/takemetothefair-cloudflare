/**
 * OPE-237 — vendor claim/registration realness screen.
 *
 * Does automatically what an analyst did by hand on 2026-07-16 for the
 * `cd-ceramics-and-florals` signup: judge whether a newly self-registered
 * vendor is a real business or spam, and hand a reviewer ranked evidence
 * instead of a blank page.
 *
 * ## Everything here is PURE
 *
 * No network, no DB, no clock. The whole judgement is a function of inputs the
 * caller supplies, so the scoring can be exhaustively unit-tested and the
 * thresholds argued about without standing up a Worker. The network half
 * (fetching a declared website) lives in the enrichment dispatcher and arrives
 * here as an already-classified `CorroborationClass`.
 *
 * ## This NEVER decides anything
 *
 * Per the ticket's guardrail: the score informs a human, it never auto-approves
 * and never auto-rejects. `SUSPECT` means "look at this first", not "delete".
 * Nothing in this module writes to a public profile.
 */

/**
 * How well an independent web presence corroborates the claim.
 *
 * - `STRONG`   — a declared website fetched successfully AND its content
 *                references the business name. A real, live presence.
 * - `WEAK`     — a presence was declared but is dead (404 / unreachable /
 *                parked). The ticket calls this out specifically: an
 *                indexed-but-dead presence is *caution*, not corroboration.
 *                Scored NEGATIVE, because claiming a site that doesn't exist is
 *                worse evidence than claiming none at all.
 * - `NONE`     — no web presence declared. Neutral: most craft vendors are
 *                Instagram-only or word-of-mouth. Absence of evidence is not
 *                evidence of absence.
 * - `UNAVAILABLE` — corroboration has not been attempted yet, or could not be
 *                (see the search-API gap in the module docs of
 *                `claim-evidence.ts`). Scored neutral and surfaced to the
 *                reviewer as "not checked", never silently as "clean".
 */
export type CorroborationClass = "STRONG" | "WEAK" | "NONE" | "UNAVAILABLE";

/** Reviewer-facing triage band derived from the score. */
export type RealnessBand = "LIKELY_REAL" | "NEEDS_REVIEW" | "SUSPECT";

/** Raw inputs for the cheap, local coherence pass. */
export interface CoherenceInput {
  /** The registrant's personal name, as typed at signup. */
  claimantName: string | null | undefined;
  /** The business name they registered. */
  businessName: string;
  /** Their account email. */
  email: string;
  /** Whether they have completed the double-opt-in email verification. */
  emailVerified: boolean;
  /** Website they declared at signup, if any. */
  website?: string | null;
  /** Free-text profile description, if any — the spam surface. */
  description?: string | null;
  /**
   * OPE-239 — how many of our fairs this vendor says they've sold at.
   * POSITIVE-ONLY: a non-zero count boosts the score; zero never penalizes,
   * because our roster coverage is far too sparse for silence to be evidence.
   */
  selfReportedEventCount?: number;
}

/** The individual signals, each independently meaningful to a reviewer. */
export interface CoherenceSignals {
  emailVerified: boolean;
  /** Email local-part shares a meaningful token with the business name. */
  emailMatchesBusiness: boolean;
  /** Email domain === declared website domain (OPE-64's domain-match rung). */
  emailDomainMatchesWebsite: boolean;
  /** Free provider (gmail/yahoo/...). NOT negative — just carries no domain signal. */
  freeMailProvider: boolean;
  /** The person's name is embedded in the business name (Colette Dewan → CD Ceramics). */
  claimantNameInBusiness: boolean;
  /** The email local part carries the person's own name (Blaise Tardif → bntardif). */
  emailMatchesClaimantName: boolean;
  websiteProvided: boolean;
  /** Spam fingerprints found in the free text. Any hit is a strong negative. */
  spamFlags: SpamFlag[];
  /** OPE-239 — count of vendor-stated fair appearances. Never negative. */
  selfReportedEventCount: number;
}

export type SpamFlag = "injected_urls" | "keyword_stuffing" | "gibberish_business_name";

export interface RealnessResult {
  /** 0–100. Higher = more likely a real business. */
  score: number;
  band: RealnessBand;
  signals: CoherenceSignals;
  corroboration: CorroborationClass;
  /** Ordered, human-readable justification — what the reviewer actually reads. */
  reasons: string[];
}

/**
 * Free mail providers. Presence here is deliberately NOT penalised: a huge
 * share of legitimate craft/food vendors run on Gmail. It only means the
 * email domain can carry no corroborating signal, so we neither add nor
 * subtract — we just don't award the domain-match points.
 */
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "comcast.net",
  "verizon.net",
  "sbcglobal.net",
]);

/**
 * Tokens too generic to count as a name match. Without this, "The Sourced
 * Parlor" would "match" any email containing "the", and every business with
 * "LLC" would match every other one.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "llc",
  "inc",
  "co",
  "company",
  "shop",
  "store",
  "farm",
  "cafe",
  "kitchen",
  "designs",
  "design",
  "studio",
  "crafts",
  "craft",
  "goods",
  "market",
  "of",
  "by",
  "at",
  "with",
]);

/**
 * Split free text into lowercase alphanumeric tokens.
 *
 * The `no-restricted-syntax` rule (#120) bans a bare `/[^a-z0-9]+/` because a
 * hand-rolled chain like that silently produced divergent SLUGS in production.
 * This is not slug generation — it is tokenization for comparison, and it never
 * produces a stored value. Centralised here so the exemption is argued once
 * rather than sprinkled as four inline disables.
 */
// eslint-disable-next-line no-restricted-syntax
const NON_ALNUM = /[^a-z0-9]+/;

export function splitTokens(s: string): string[] {
  return s.toLowerCase().split(NON_ALNUM).filter(Boolean);
}

/** Lowercase alphanumeric tokens, stopwords removed, 3+ chars. */
function meaningfulTokens(s: string): string[] {
  return splitTokens(s).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Initials of the meaningful words, e.g. "Colette Dewan" → "cd". */
function initials(s: string): string {
  return s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
}

/**
 * Minimum prefix length for a fuzzy name match.
 *
 * "Blaise Tardif" registered "Blaisbtwoodworking" — the business name elides
 * the trailing 'e' AND runs every word together, so neither an exact token
 * match nor a word-boundary initials match fires. Five characters is short
 * enough to catch that and long enough that "Mark" doesn't match "Market".
 */
const NAME_PREFIX_MIN = 5;

/**
 * Does a personal-name token appear in a business name, allowing for the
 * concatenation and truncation people actually use when naming a business?
 *
 * Tokens of >= NAME_PREFIX_MIN chars match on any prefix of that length, so
 * "blaise" matches "blaisbtwoodworking" via "blais". Shorter tokens require a
 * whole-word match, because a 3-4 char substring inside a longer word is
 * coincidence more often than signal.
 */
function nameTokenAppearsIn(token: string, haystackLower: string, haystackRaw: string): boolean {
  if (token.length >= NAME_PREFIX_MIN) {
    for (let len = token.length; len >= NAME_PREFIX_MIN; len--) {
      if (haystackLower.includes(token.slice(0, len))) return true;
    }
    return false;
  }
  return new RegExp(`\\b${token}\\b`, "i").test(haystackRaw);
}

function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Spam fingerprints in registrant-supplied free text.
 *
 * Tuned to be quiet: a false SUSPECT on a real vendor costs a human an
 * apology, so each rule needs an unambiguous signature rather than a hunch.
 */
function detectSpam(businessName: string, description: string | null | undefined): SpamFlag[] {
  const flags: SpamFlag[] = [];
  const desc = (description ?? "").trim();

  // Link farming: two or more URLs in what should be a description of one
  // business. One link is normal (their own site); several is a payload.
  const urlCount = (desc.match(/https?:\/\/|www\./gi) ?? []).length;
  if (urlCount >= 2) flags.push("injected_urls");

  // Keyword stuffing: one token repeated many times. Requires enough words
  // that the ratio means something — a 6-word description repeating a word
  // twice is just English.
  const words = splitTokens(desc);
  if (words.length >= 12) {
    const counts = new Map<string, number>();
    for (const w of words) {
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const worst = Math.max(0, ...counts.values());
    if (worst / words.length > 0.2) flags.push("keyword_stuffing");
  }

  // Gibberish business name: no vowels at all, or majority digits. Catches
  // "xkcdfgh" and "8829271" without catching real short names like "Douse".
  const nameLetters = businessName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (nameLetters.length >= 4) {
    const vowels = (nameLetters.match(/[aeiouy]/g) ?? []).length;
    const digits = (nameLetters.match(/[0-9]/g) ?? []).length;
    if (vowels === 0 || digits / nameLetters.length > 0.5) {
      flags.push("gibberish_business_name");
    }
  }

  return flags;
}

/** Compute the cheap, local, network-free coherence signals. */
export function computeCoherenceSignals(input: CoherenceInput): CoherenceSignals {
  const email = (input.email ?? "").trim().toLowerCase();
  const atIdx = email.lastIndexOf("@");
  const localPart = atIdx > 0 ? email.slice(0, atIdx) : email;
  const emailDomain = atIdx > 0 ? email.slice(atIdx + 1) : "";

  const bizTokens = meaningfulTokens(input.businessName);
  const localTokens = splitTokens(localPart);

  // A match is any meaningful business token appearing inside the local part
  // (cdceramicsandflorals contains "ceramics"), or the local part appearing
  // whole inside the business name.
  const emailMatchesBusiness =
    bizTokens.some((t) => localPart.includes(t)) ||
    (localTokens.length > 0 &&
      bizTokens.length > 0 &&
      localTokens.some((t) => t.length >= 4 && input.businessName.toLowerCase().includes(t)));

  const websiteDomain = domainOf(input.website);
  const emailDomainMatchesWebsite =
    !!websiteDomain && !!emailDomain && websiteDomain === emailDomain;

  // The person's name in the business name — either a full token overlap
  // ("Roxy" in "Foxy Roxy Homemade") or the initials pattern the analyst
  // spotted by hand (Colette Dewan → CD Ceramics and Florals).
  const claimantName = (input.claimantName ?? "").trim();
  const nameTokens = meaningfulTokens(claimantName);
  const bizLower = input.businessName.toLowerCase();
  const nameInitials = initials(claimantName);
  const claimantNameInBusiness =
    nameTokens.some((t) => nameTokenAppearsIn(t, bizLower, input.businessName)) ||
    (nameInitials.length >= 2 && new RegExp(`\\b${nameInitials}\\b`, "i").test(input.businessName));

  // OPE-237 calibration — the email carrying the registrant's OWN name is
  // coherence too, and it is what a human reads first. "bntardif" for Blaise
  // Tardif is a real person using a real address; the original screen scored it
  // as nothing because the address didn't reference the BUSINESS.
  const emailMatchesClaimantName = nameTokens.some((t) =>
    nameTokenAppearsIn(t, localPart, localPart)
  );

  return {
    emailVerified: input.emailVerified,
    emailMatchesBusiness,
    emailDomainMatchesWebsite,
    freeMailProvider: FREE_MAIL_DOMAINS.has(emailDomain),
    claimantNameInBusiness,
    emailMatchesClaimantName,
    websiteProvided: !!websiteDomain,
    spamFlags: detectSpam(input.businessName, input.description),
    selfReportedEventCount: Math.max(0, input.selfReportedEventCount ?? 0),
  };
}

/**
 * Points per signal. Deliberately additive and small-integer so a reviewer can
 * reconstruct any score by reading the reasons list — an opaque weighted model
 * would be impossible to argue with, and this exists to be argued with.
 */
const POINTS = {
  emailVerified: 25,
  emailDomainMatchesWebsite: 25,
  emailMatchesBusiness: 15,
  claimantNameInBusiness: 10,
  emailMatchesClaimantName: 10,
  websiteProvided: 5,
  corroborationStrong: 30,
  /** Negative: a declared-but-dead presence is worse than none. */
  corroborationWeak: -15,
  /** Each spam fingerprint. Two hits alone are enough to reach SUSPECT. */
  spamFlag: -30,
  /**
   * OPE-239 — naming even one of our fairs is meaningful: a spammer has no
   * reason to, and it is checkable against the event. Capped low and flat so a
   * long list can't dominate a score built from independent signals — someone
   * who ticks twenty boxes is not twenty times more real than someone who
   * ticks one.
   */
  selfReportedAny: 10,
  selfReportedSeveral: 5,
} as const;

/**
 * Score >= LIKELY_REAL_AT is LIKELY_REAL. Below SUSPECT_BELOW is SUSPECT *only
 * when an actual negative signal is present* — see the banding note in
 * scoreRealness for why absence alone must never reach SUSPECT.
 */
const LIKELY_REAL_AT = 60;
const SUSPECT_BELOW = 20;

/**
 * Combine coherence + corroboration into a 0–100 score, a triage band, and the
 * human-readable reasons that justify both.
 */
export function scoreRealness(
  signals: CoherenceSignals,
  corroboration: CorroborationClass
): RealnessResult {
  let score = 0;
  const reasons: string[] = [];

  if (signals.emailVerified) {
    score += POINTS.emailVerified;
    reasons.push("Email address verified (double opt-in completed)");
  } else {
    reasons.push("Email address NOT yet verified");
  }

  if (signals.emailDomainMatchesWebsite) {
    score += POINTS.emailDomainMatchesWebsite;
    reasons.push("Email domain matches the declared website domain (OPE-64 domain-match rung)");
  } else if (signals.freeMailProvider) {
    reasons.push("Free email provider — carries no domain signal either way");
  }

  if (signals.emailMatchesBusiness) {
    score += POINTS.emailMatchesBusiness;
    reasons.push("Email address references the business name");
  }

  if (signals.claimantNameInBusiness) {
    score += POINTS.claimantNameInBusiness;
    reasons.push("Registrant's own name appears in the business name");
  }

  if (signals.emailMatchesClaimantName) {
    score += POINTS.emailMatchesClaimantName;
    reasons.push("Email address carries the registrant's own name");
  }

  if (signals.websiteProvided) {
    score += POINTS.websiteProvided;
    reasons.push("A website was declared at signup");
  }

  switch (corroboration) {
    case "STRONG":
      score += POINTS.corroborationStrong;
      reasons.push("Declared web presence is live and references the business");
      break;
    case "WEAK":
      score += POINTS.corroborationWeak;
      reasons.push(
        "CAUTION: declared web presence is dead or unreachable — claiming a site that does not resolve is weaker evidence than claiming none"
      );
      break;
    case "NONE":
      reasons.push("No web presence declared (common and not suspicious on its own)");
      break;
    case "UNAVAILABLE":
      reasons.push("Web corroboration not checked — treat as unknown, not as clean");
      break;
  }

  if (signals.selfReportedEventCount > 0) {
    score += POINTS.selfReportedAny;
    let detail = `Names ${signals.selfReportedEventCount} of our fair(s) as one they've exhibited at`;
    if (signals.selfReportedEventCount >= 3) {
      score += POINTS.selfReportedSeveral;
      detail += " (an established pattern, not a one-off)";
    }
    reasons.push(detail);
  }

  for (const flag of signals.spamFlags) {
    score += POINTS.spamFlag;
    reasons.push(`SPAM FINGERPRINT: ${flag.replace(/_/g, " ")}`);
  }

  score = Math.max(0, Math.min(100, score));

  // SUSPECT requires an ACTUAL NEGATIVE, not merely an absence of positives.
  //
  // Shipped 2026-07-27 without this and the very first live signup proved it
  // wrong: Blaise Tardif, a plausible woodworker on Gmail with no website who
  // simply hadn't clicked the verification link yet, scored 0 and was branded
  // SUSPECT — with three reason lines that each said "unknown", not "wrong".
  // That is the modal legitimate craft vendor here (13 of 14 existing claimed
  // vendors have exactly that shape), so the screen would have libelled almost
  // every honest new registrant during the minutes-to-hours before they verify.
  //
  // "Nothing is known yet" and "something is wrong" are different states and
  // must not share a band. NEEDS_REVIEW is the honest home for the first.
  const hasNegativeSignal = signals.spamFlags.length > 0 || corroboration === "WEAK";
  const band: RealnessBand =
    score >= LIKELY_REAL_AT
      ? "LIKELY_REAL"
      : hasNegativeSignal && score < SUSPECT_BELOW
        ? "SUSPECT"
        : "NEEDS_REVIEW";

  return { score, band, signals, corroboration, reasons };
}

/** Convenience: signals + score in one call, for callers with raw input. */
export function assessRealness(
  input: CoherenceInput,
  corroboration: CorroborationClass = "UNAVAILABLE"
): RealnessResult {
  return scoreRealness(computeCoherenceSignals(input), corroboration);
}
