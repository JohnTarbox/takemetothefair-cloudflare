/**
 * OPE-325 — is this image a POSTER announcing an event, or a PHOTO from one?
 *
 * The Maynard MusicFest episode: John emailed an event poster to submit@. The
 * OPE-315 router correctly sent it to the photo lane — but that lane's only
 * model is "photos FROM an existing fair", so it asked "which fair?" about a
 * poster ANNOUNCING a new one. No Maynard event existed, so the happy path
 * could not complete and a human extracted it by hand.
 *
 * Classification runs on the OCR TEXT, not on a second vision call. The photo
 * lane already needs the text for extraction, so one pass serves both — the
 * "cheap classification" the ticket asks for costs nothing extra, and the
 * verdict is explainable ("312 chars, found a date") rather than a model's
 * unexaminable opinion. That matters because OPE-204's rule stands: no public
 * writes from an unmeasured classifier, and a verdict you can read is one you
 * can audit at a retro.
 *
 * The asymmetry is deliberate. A missed poster costs a "which fair?" reply the
 * sender can answer. A booth photo misread as a poster would extract nonsense
 * and stage a junk event. So BOOTH and UNKNOWN both fall through to the
 * existing which-fair flow, and only a confident poster reroutes.
 */

export type PosterVerdict = "POSTER" | "BOOTH_OR_SCENERY" | "UNKNOWN";

export interface PosterClassification {
  verdict: PosterVerdict;
  /** Human-readable basis for the verdict — logged so precision is computable. */
  reason: string;
  chars: number;
  hasDate: boolean;
}

/**
 * Below this, there is not enough text for the image to be an announcement.
 * A booth photo's OCR is typically a banner word or two; a poster carries the
 * event name, a date, a venue and usually admission or contact details.
 */
const MIN_POSTER_CHARS = 120;

/** Under this, we call it a photo rather than staying unsure — near-empty OCR
 *  is the signature of a scene, not a flyer. */
const BOOTH_MAX_CHARS = 40;

/**
 * Date shapes a poster actually uses. Deliberately broad on format and strict
 * on presence: an announcement without a date is not one we could stage
 * anyway, since the extractor needs a date to dedup against.
 */
const DATE_PATTERNS: RegExp[] = [
  // "August 15", "Aug 15th", "SEPTEMBER 3-5". The ordinal suffix is not
  // optional decoration — posters write "Aug 15th" constantly, and \d{1,2}\b
  // silently fails on it because there is no word boundary inside "15th".
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b/i,
  // "8/15", "08/15/2026"
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
  // "2026-08-15"
  /\b\d{4}-\d{2}-\d{2}\b/,
  // "15 August", "15th August"
  /\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
];

/** Words that appear on announcements and essentially never on a booth shot. */
const ANNOUNCEMENT_HINTS =
  /\b(festival|fair|admission|tickets?|vendors?\s+wanted|applications?|rain\s+or\s+shine|free\s+admission|live\s+music|craft\s+show|open\s+to\s+the\s+public|presented\s+by|\d{1,2}\s*(am|pm))\b/i;

export function classifyPosterText(rawText: string | null | undefined): PosterClassification {
  const text = (rawText ?? "").replace(/\s+/g, " ").trim();
  const chars = text.length;
  const hasDate = DATE_PATTERNS.some((re) => re.test(text));

  if (chars <= BOOTH_MAX_CHARS) {
    return {
      verdict: "BOOTH_OR_SCENERY",
      reason: `only ${chars} chars of text — reads as a scene, not an announcement`,
      chars,
      hasDate,
    };
  }

  if (chars >= MIN_POSTER_CHARS && hasDate) {
    const hinted = ANNOUNCEMENT_HINTS.test(text);
    return {
      verdict: "POSTER",
      reason: `${chars} chars with a date${hinted ? " and announcement wording" : ""}`,
      chars,
      hasDate,
    };
  }

  // Text-heavy but dateless, or dated but sparse. Either could be a busy
  // banner in a photo. Falls through to which-fair, which is recoverable.
  return {
    verdict: "UNKNOWN",
    reason: hasDate
      ? `has a date but only ${chars} chars — too sparse to call a poster`
      : `${chars} chars but no date found — an announcement without a date can't be staged`,
    chars,
    hasDate,
  };
}
