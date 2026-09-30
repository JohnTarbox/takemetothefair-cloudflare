/**
 * OPE-803 — is there a real, checkable event buried in a message we called spam?
 *
 * `intent='spam'` is the only terminal disposition in the inbound lane: 19 rows
 * since 2026-06-19, all with `routed_to_workflow = 0`, `parsed_url = 0`,
 * `resulting_event_id = 0`. Nothing reads them.
 *
 * John's framing (2026-09-04), which is the whole design:
 *
 *   > Sender credibility and message value are independent axes. Do not
 *   > collapse them.
 *
 * So this module answers exactly one question — *does this message name a
 * specific event?* — and deliberately does NOT answer "is this sender
 * trustworthy". A broker stays a broker. What the detector produces is a
 * routing hint; the value of anything it finds is established later, against an
 * INDEPENDENT source, never against the sender's prose.
 *
 * ## What this must not become
 *
 * OPE-278 is the failure this sits next to: a near-identical broker pitch was
 * classified `new_event`, extraction ran **directly on the pitch**, and it
 * created a duplicate live event with a fabricated description. Nothing here
 * extracts. `detectEventTriple` returns spans of text for a human or a
 * confirmation step to check — the strings it returns are evidence that a
 * claim was MADE, never evidence that it is TRUE.
 *
 * ## Why it reads `body_text` and not just the excerpt
 *
 * The ticket's Scope §1 says to test the excerpt. On the specimen the ticket
 * was filed on (`912c661e`) that would fail: the 500-char excerpt ends
 * mid-sentence at "meeting opportunities." and the labelled block carrying the
 * date and the venue begins at char ~500. The excerpt holds the event NAME and
 * nothing else.
 *
 * The body is available because OPE-762 shipped on 2026-09-02 (`77f49b50`) —
 * `insertSpamAuditRow` had simply omitted `bodyTextStored`/`bodyHtmlStored`
 * from its INSERT, so they landed NULL. Every spam row before that date has
 * `body_text = 0`; the one row after it has 1,034 chars. So: read the body when
 * it is there, fall back to the excerpt when it is not, and let the caller
 * distinguish the two — because "no triple found" and "the text was thrown
 * away in 2026-08" must not look the same. (That conflation is OPE-804, one
 * lane over.)
 */

/** A span the detector found, kept verbatim so a reviewer can judge it. */
export interface TripleEvidence {
  /** The candidate event name. */
  name: string | null;
  /** The date text exactly as written — NOT parsed. Parsing is extraction. */
  dateText: string | null;
  /** The place text exactly as written. */
  place: string | null;
}

export interface TripleResult extends TripleEvidence {
  /** All three present → this row is worth routing for review. */
  hit: boolean;
  /**
   * Which surface the detector actually read. `"excerpt"` means the full body
   * was NULL — a miss on an excerpt is weak evidence, because the text that
   * would have carried the triple may simply not be stored.
   */
  read: "body" | "excerpt" | "none";
  /** True when the body was absent, so a miss here is inconclusive. */
  truncated: boolean;
}

/**
 * Forwarded-message header blocks, stripped before anything else runs.
 *
 * This is not tidiness — it is the guard that stops the largest false-positive
 * family in the live data. Three of the 19 spam rows are John forwarding
 * himself GitHub CI failures, and a forwarded header block reads:
 *
 *     ---------- Forwarded message ---------
 *     From: John Tarbox <notifications@github.com>
 *     Date: Mon, Aug 17, 2026, 10:53
 *     Subject: [JohnTarbox/takemetothefair-cloudflare] Run failed: CI - main
 *
 * A `Date:` line and a `Subject:` line, sitting together, in a message about
 * nothing at all. Without this strip, a date-plus-proper-noun detector fires on
 * every forwarded email in the corpus.
 */
const FORWARD_HEADER_BLOCK =
  /-{2,}\s*(?:Forwarded message|Original Message)\s*-{2,}[\s\S]{0,600}?(?:\n\s*\n|$)/gi;

/**
 * Bare RFC-822 header lines that survive outside a marked block.
 *
 * ⚠️ `Date:` and `Subject:` are deliberately NOT in this list, and the omission
 * is the whole point. A first version included them and made the labelled form
 * — `Date: 12 September 2026` — undetectable: the stripper removed the line
 * before the detector could read it. Every negative test still passed, because
 * a guard that deletes too much only ever looks MORE correct on
 * must-not-fire cases. Only a positive case exposed it.
 *
 * Those two labels are ambiguous by nature — they are transport headers AND
 * the words a human writes when stating when and what. The disambiguation is
 * structural, not lexical: a real header block is preceded by a forwarding
 * marker, and FORWARD_HEADER_BLOCK above consumes it whole. What is left here
 * is only the unambiguously-transport set.
 */
const RFC822_HEADER_LINE = /^\s*(?:From|To|Cc|Bcc|Sent|Reply-To):.*$/gim;

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/**
 * A date with a YEAR. The year is required on purpose.
 *
 * "September 15" appears in ordinary marketing prose constantly; "15 – 16
 * September 2026" is somebody stating when a thing happens. Requiring the year
 * is the cheapest available precision, and this detector's false positives cost
 * an operator's attention on every one.
 */
const DATE_PATTERNS: RegExp[] = [
  // 15 – 16 September 2026 / 15-16 September 2026 / 15 September 2026
  new RegExp(`\\b\\d{1,2}\\s*(?:[–—-]\\s*\\d{1,2}\\s*)?${MONTH}\\.?,?\\s+\\d{4}\\b`, "i"),
  // September 15-16, 2026 / September 15, 2026
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}\\s*(?:[–—-]\\s*\\d{1,2}\\s*)?,?\\s*\\d{4}\\b`, "i"),
  // June 28 - July 5, 2026
  new RegExp(
    `\\b${MONTH}\\.?\\s+\\d{1,2}\\s*[–—-]\\s*${MONTH}\\.?\\s+\\d{1,2},?\\s*\\d{4}\\b`,
    "i"
  ),
];

/** US states, full and abbreviated — the place signal. */
const STATES = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
];
const STATE_RE = new RegExp(`\\b(?:${STATES.join("|")})\\b`, "i");
const STATE_ABBR_RE =
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[A]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;
/** Venue nouns — a place even when no city is named. */
const VENUE_NOUN_RE =
  /\b(?:Fairgrounds?|Convention\s+Cent(?:er|re)|Conference\s+Cent(?:er|re)|Expo\s+Cent(?:er|re)|Civic\s+Cent(?:er|re)|Hotel|Arena|Coliseum|Pavilion|Grange\s+Hall|Armory|Racetrack|Speedway)\b/i;

/** Words that make a proper-noun run an EVENT rather than a company. */
const EVENT_NOUN_RE =
  /\b(?:Fair|Festival|Expo|Exposition|Show|Market|Bazaar|Carnival|Jamboree|Rodeo|Round-?up|Days?|Celebration|Fest)\b/;

/**
 * `*Event:*` / `*Date:*` / `*Location:*` — the labelled form.
 *
 * Worth special-casing because it is unambiguous and it is what the specimen
 * actually uses. Broker pitches are machine-generated from a template, so the
 * labelled shape recurs across the genre.
 */
const LABELLED: Record<keyof TripleEvidence, RegExp> = {
  name: /^[*\s]*Event[*\s]*:[*\s]*(.+?)\s*$/im,
  dateText: /^[*\s]*Dates?[*\s]*:[*\s]*(.+?)\s*$/im,
  place: /^[*\s]*(?:Location|Venue|Where)[*\s]*:[*\s]*(.+?)\s*$/im,
};

/** Strip forwarded/quoted header noise so it cannot be read as event data. */
function stripHeaderNoise(text: string): string {
  return text.replace(FORWARD_HEADER_BLOCK, "\n").replace(RFC822_HEADER_LINE, "");
}

/** First match of any pattern, or null. */
function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

/**
 * A proper-noun run containing an event noun — "New England Made Giftware &
 * Specialty Food Show 2026".
 *
 * Requires at least two capitalised tokens so a bare "Show" or "the fair" does
 * not qualify.
 */
function findEventName(text: string): string | null {
  const RUN =
    /\b(?:[A-Z][\w'&.-]*|&|of|the|and|for|at|in)(?:\s+(?:[A-Z][\w'&.-]*|&|of|the|and|for|at|in)){1,11}\b/g;
  for (const m of text.matchAll(RUN)) {
    const run = m[0].trim();
    if (!EVENT_NOUN_RE.test(run)) continue;
    // Two real capitalised words, not just "The Show".
    const caps = run.split(/\s+/).filter((w) => /^[A-Z]/.test(w));
    if (caps.length < 2) continue;
    return run;
  }
  return null;
}

function findPlace(text: string): string | null {
  const abbr = text.match(STATE_ABBR_RE);
  if (abbr) return abbr[0].trim();
  const state = text.match(STATE_RE);
  if (state) {
    // Give the reviewer the surrounding clause, not a bare "Massachusetts".
    const i = state.index ?? 0;
    return (
      text
        .slice(Math.max(0, i - 60), i + state[0].length)
        .trim()
        .split("\n")
        .pop() ?? state[0]
    );
  }
  const venue = text.match(VENUE_NOUN_RE);
  return venue ? venue[0].trim() : null;
}

/**
 * Does this message name a specific event?
 *
 * Fails toward inclusion per Scope §1 — a false hit costs one operator glance
 * at a review queue, a false miss costs an event we never learn about. But
 * "toward inclusion" is not "on anything": every signal below still requires a
 * YEAR on the date and two capitalised tokens in the name, because the live
 * corpus is 53% one weekly marketing newsletter and a detector that fired on it
 * ten times would be turned off within a week.
 */
export function detectEventTriple(input: {
  bodyText: string | null | undefined;
  bodyTextExcerpt: string | null | undefined;
  subject?: string | null;
}): TripleResult {
  const body = (input.bodyText ?? "").trim();
  const excerpt = (input.bodyTextExcerpt ?? "").trim();
  const read: TripleResult["read"] = body ? "body" : excerpt ? "excerpt" : "none";
  const source = body || excerpt;

  if (!source) {
    return { hit: false, name: null, dateText: null, place: null, read, truncated: true };
  }

  // The subject is included for the NAME signal only. It is the one header a
  // sender writes as prose, and on the specimen it carries the event name in
  // full. It is never read for a date: `Subject:` lines sit next to `Date:`
  // lines in forwarded blocks, which is the false positive being avoided.
  const clean = stripHeaderNoise(source);
  const nameSurface = `${input.subject ?? ""}\n${clean}`;

  const name = clean.match(LABELLED.name)?.[1]?.trim() ?? findEventName(nameSurface);
  // Two date rules, and the asymmetry is deliberate.
  //
  // LABELLED (`Date: …`) accepts whatever follows, year or not. A template
  // that writes the word "Date" next to a value is stating an event date, and
  // brokers really do write "*Date:* Sept 12-13". Requiring a year there
  // would reject the genre this ticket exists to catch.
  //
  // UNLABELLED requires a year, because a bare "September 15" floating in
  // prose is ordinary marketing copy. Ten of the nineteen live spam rows are
  // one weekly newsletter; a detector that fired on loose month-day text
  // would surface it every week and be muted within one.
  const dateText = clean.match(LABELLED.dateText)?.[1]?.trim() || firstMatch(clean, DATE_PATTERNS);
  const place = clean.match(LABELLED.place)?.[1]?.trim() ?? findPlace(clean);

  return {
    hit: Boolean(name && dateText && place),
    name,
    dateText,
    place,
    read,
    // A miss read off an excerpt is inconclusive: the body may simply have been
    // discarded before OPE-762 landed on 2026-09-02.
    truncated: read !== "body",
  };
}

/**
 * Should this quarantined row be routed for review instead of terminating?
 *
 * Extracted from the call site so the gate is testable on its own. The routing
 * function it lives in is private, takes a large env-bearing args object, and
 * calls the AI classifier — so a decision left inline there is a decision no
 * test ever executes. Exactly the shape this ticket's neighbour (OPE-804) was
 * filed about: a control that cannot be exercised is not a control.
 *
 * ⚠️ Reads the flag as a STRING and compares to `"true"` exactly.
 * `SPAM_EVENT_RECOVERY_ENABLED` is a plaintext Workers `[vars]` entry, so it
 * arrives as a string or as `undefined` — never as a boolean. A truthiness
 * check would make the literal string `"false"` enable the feature, which is
 * how a flag ships dark and runs anyway.
 */
export function shouldRecoverSpamRow(
  triple: Pick<TripleResult, "hit">,
  flagValue: string | undefined | null
): boolean {
  return triple.hit === true && flagValue === "true";
}
