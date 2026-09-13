/**
 * OPE-954 — keep the OCR step's result under the Workflow step-output cap.
 *
 * `ocr-attachments` returns every attachment's OCR text as its step result, and
 * Cloudflare caps a non-stream step result at 1 MiB (2^20 bytes — Workflows
 * limits page, read 2026-09-13). The first real forward-as-attachment (inbound
 * f8ef71e5: four PNGs of 958/934/543/536 KB) blew it:
 *
 *   Step ocr-attachments-1 output is too large. Maximum allowed size is 1MiB.
 *
 * and the WHOLE submission died with `extract-failed` — body, URL and every
 * other source already extracted, no event created.
 *
 * Two bounds, both measured rather than guessed:
 *
 * 1. PER SOURCE: `MAX_FETCH_CONTENT_LEN` (submit.ts) — the extractor slices every
 *    free-text source to this length (`submitFreeTextExtract`), so text beyond
 *    it was never read by anything that turns text into events. (It slices
 *    AFTER stripping a forward preamble and signature, so the raw prefix kept
 *    here can be a few hundred chars shorter than what it would have read —
 *    the only loss, and it is at the far end of a 100k-char document.)
 * 2. AGGREGATE: a byte budget on the serialized result, well under the cap, so
 *    several at-limit sources — or multi-byte text, where one char is up to
 *    four bytes — still fit. Later sources are shortened, and dropped only if
 *    what is left would be too short to be a source at all.
 *
 * Every truncation is reported, never silent: the caller logs it and stamps it
 * on the per-attachment OCR record, so "the flyer said nothing more" and "we
 * cut the flyer off" stay distinguishable.
 */

/** Cloudflare's cap on a non-stream step result. */
export const WORKFLOW_STEP_RESULT_MAX_BYTES = 1024 * 1024;

/**
 * The serialized OCR result is kept under this. 3/4 of the cap leaves room for
 * JSON escaping of characters we did not count and for the result envelope.
 */
export const OCR_STEP_BUDGET_BYTES = Math.floor(WORKFLOW_STEP_RESULT_MAX_BYTES * 0.75);

export interface TextSource {
  text: string;
}

export interface OcrBoundReport {
  /** Index into the input array. */
  index: number;
  originalChars: number;
  keptChars: number;
  reason: "per-source-cap" | "step-budget" | "dropped-step-budget";
}

const utf8 = new TextEncoder();
const byteLen = (v: unknown) => utf8.encode(JSON.stringify(v)).length;

/** Longest prefix of `text` whose JSON-serialized form fits in `maxBytes`. */
function prefixFitting(text: string, maxBytes: number): string {
  if (byteLen(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLen(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

export function boundOcrSources<T extends TextSource>(
  sources: ReadonlyArray<T>,
  opts: { perSourceMaxChars: number; budgetBytes: number; minChars: number }
): { sources: T[]; truncations: OcrBoundReport[]; bytes: number } {
  const out: T[] = [];
  const truncations: OcrBoundReport[] = [];

  sources.forEach((s, index) => {
    const originalChars = s.text.length;
    let text = s.text;
    let reason: OcrBoundReport["reason"] | null = null;

    if (text.length > opts.perSourceMaxChars) {
      text = text.slice(0, opts.perSourceMaxChars);
      reason = "per-source-cap";
    }

    // What is already committed, plus this source with an EMPTY text, is the
    // fixed cost; whatever the budget leaves is what the text may use.
    const fixed = byteLen([...out, { ...s, text: "" }]);
    const room = opts.budgetBytes - fixed;
    if (byteLen(text) > room) {
      text = room > 0 ? prefixFitting(text, room) : "";
      if (text.trim().length < opts.minChars) {
        truncations.push({ index, originalChars, keptChars: 0, reason: "dropped-step-budget" });
        return;
      }
      reason = "step-budget";
    }

    if (reason) truncations.push({ index, originalChars, keptChars: text.length, reason });
    out.push({ ...s, text });
  });

  return { sources: out, truncations, bytes: byteLen(out) };
}
