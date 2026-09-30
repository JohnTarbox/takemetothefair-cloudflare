/**
 * OPE-832 — recognise a product defect described in an inbound email.
 *
 * The defect queue was fed by the web form and by `report@` / `feedback@` only.
 * `problem_report` intent is assigned by RECIPIENT ADDRESS
 * (`email-intents.ts` INTENT_MAP), so a customer who describes a bug to any
 * other address is invisible to it — and every real one has.
 *
 * Measured in prod over 180 days (2026-09-07). Three distinct incidents, four
 * emails, ALL classified `intent=support`, ALL producing zero problem_reports:
 *
 *   4c4fe4f5  2026-09-06  notify@   "…it says it's saved it still doesn't save"
 *   1b65e94a  2026-08-10  hello@    "…sign up page… appears to be bugged"
 *   cae4be85  2026-07-09  support@  "…I'm getting an error message at the top"
 *   2c194709  2026-07-09  submit@   (the same report, forwarded)
 *
 * Note the four DIFFERENT recipient addresses. That is why this is a body
 * detector and not another INTENT_MAP entry: there is no address to add.
 *
 * ⚠️ The comment at `email-intents.ts:47` claims the classifier "can also tag
 * misrouted reports landing on support@ as problem_report when the body matches
 * problem-language keywords". **No such code exists** — grep for
 * `problem_report` across `mcp-server/src` returns the union type, the two
 * INTENT_MAP rows, a fan-out priority, and reply-copy strings. Nothing reads a
 * body. This module is that comment finally becoming true.
 *
 * ── Why apostrophes are load-bearing ────────────────────────────────────
 *
 * The first version of this measurement query missed Joe's email — the
 * ticket's own headline specimen — because he wrote `doesn’t` with U+2019 and
 * the pattern used U+0027. Phones and Gmail substitute typographic quotes
 * automatically, so a detector matching only straight apostrophes silently
 * misses exactly the mobile users most likely to be reporting a mobile bug.
 * It would have looked correct, passed a hand-written test, and never fired on
 * the specimen it was built for. Normalisation is therefore the first thing
 * this does, and it is pinned by its own test.
 */

/**
 * Fold the characters that differ only by keyboard: curly quotes to straight,
 * non-breaking space to space, collapse whitespace, lowercase.
 *
 * U+2019 RIGHT SINGLE QUOTATION MARK is the one that matters (it is what iOS
 * and Gmail produce for an apostrophe); the rest are cheap to include and stop
 * the same class of miss.
 */
export function normalizeForDefectMatch(text: string): string {
  return text
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Phrases that describe something MALFUNCTIONING, as opposed to something the
 * sender does not know how to do.
 *
 * Deliberately narrow (scope 4: precision over recall). Every phrase names a
 * system behaving wrongly. Notably ABSENT, and absent on purpose:
 *
 *   "unable to"  — matched a forwarded vendor-application update in the 180-day
 *                  corpus (`d7ee53e0`, "unable to accommodate"). It is ordinary
 *                  English for a person declining, not a system failing.
 *   "help"/"issue with my account"/"how do I" — questions, not defects.
 *
 * Recall is knowingly imperfect: a report phrased entirely as "the site is
 * being weird" will not match. That is the correct trade here — a false
 * positive lands a junk row in the queue this ticket exists to make
 * trustworthy, and OPE-769 is open because that table already carries two kinds
 * of work.
 */
const DEFECT_PHRASES: readonly string[] = [
  "doesn't save",
  "didn't save",
  "won't save",
  "not saving",
  "doesn't work",
  "does not work",
  "doesn't load",
  "won't load",
  "not working",
  "isn't working",
  "stopped working",
  "is broken",
  "appears to be bugged",
  "is bugged",
  "error message",
  "getting an error",
  "an error occurs",
  "keeps saying",
  "keeps failing",
  "can't log in",
  "cannot log in",
  "can't sign in",
  "won't let me",
  "will not let me",
  "nothing happens when",
  "page won't",
  "404",
];

export interface DefectDetection {
  /** True when at least one defect phrase matched. */
  isDefect: boolean;
  /** Which phrases matched — recorded so a queue row can say WHY it exists. */
  matched: string[];
}

/**
 * Detect defect language in an email's text.
 *
 * Pass subject + body already concatenated; this does not care which is which.
 * Returns every match rather than short-circuiting, because the matched phrases
 * are written onto the candidate row: a reviewer seeing "matched: doesn't save"
 * can judge the call without reopening the email, and a phrase that turns out
 * to produce junk is then identifiable by name rather than by guesswork.
 */
export function detectDefectReport(text: string | null | undefined): DefectDetection {
  const t = normalizeForDefectMatch(text ?? "");
  if (!t) return { isDefect: false, matched: [] };
  const matched = DEFECT_PHRASES.filter((p) => t.includes(p));
  return { isDefect: matched.length > 0, matched };
}

/** Exposed for the test that asserts the corpus is non-trivial. */
export const DEFECT_PHRASE_COUNT = DEFECT_PHRASES.length;
