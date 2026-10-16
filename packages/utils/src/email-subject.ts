/**
 * OPE-1392 (TPL-2) — the one rule for an email Subject built from a value a
 * user (or a scraped page) supplied: a business name, an event name, a
 * contact-form sender name.
 *
 * A CR/LF in a Subject is header injection in any transport that assembles
 * MIME by string concatenation. Our providers build MIME from structured JSON
 * today, so this is defence in depth — but `sanitizeProse` deliberately keeps
 * `\n` (it is for bodies), so nothing upstream removed it.
 *
 * Every C0 control character, DEL, and the Unicode line/paragraph separators
 * are replaced; a run of them becomes ONE space, and the ends are trimmed. A
 * subject with no control characters is returned unchanged, byte for byte, so
 * existing copy does not move.
 */

const SUBJECT_CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

const SUBJECT_CONTROL_RUN = /[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g;

export function sanitizeEmailSubject(subject: string): string {
  if (!SUBJECT_CONTROL.test(subject)) return subject;
  return subject.replace(SUBJECT_CONTROL_RUN, " ").trim();
}
