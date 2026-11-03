/**
 * OPE-1316 — read the inbound pipeline's own error token out of an error that
 * crossed a Workflow step boundary.
 *
 * `submitFetch` / `submitExtract` / `submitEvent` throw messages that START with
 * a token (`extract-upstream: …`, `extract-network: …`, `extract-504`,
 * `fetch-…`, `submit-…`), and every reader in `inbound-email.ts` used to test
 * `message.startsWith(token)`. Those messages are thrown INSIDE `step.do` and
 * caught outside it, and by then the token is no longer at the start.
 *
 * Evidence, prod D1 2026-10-05: across all of `inbound_emails`,
 * `classifyExtractFailure` has never returned anything but `other` (5 rows).
 * Not one `ai-timeout`, `zero-events`, `thin-content` or `parse-error`, even
 * though NEAR-Fest (`1e10e617`) and Maine Crafts (`44d60506`) both failed on a
 * logged Workers AI timeout and `submitExtract` put `[ai: … timed out …]` in
 * the message. The unit tests passed because they threw the raw message
 * straight into the classifier, never through a step.
 *
 * So the token is located, not assumed: the message from the first known token
 * onward. A message with no token is returned whole.
 */

// `\b` so "prefetch-cache" in some unrelated text is not read as a `fetch-` token.
const TOKEN = /\b(?:extract-(?:upstream: |network:|\d{3})|fetch-|submit-)/;

export function pipelineErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (typeof msg !== "string") return "";
  const at = msg.search(TOKEN);
  return at > 0 ? msg.slice(at) : msg;
}

/**
 * K7.4 buckets for `inbound_emails.extract_fail_reason`:
 *   - 'zero-events'  : AI returned success with an empty events[]
 *   - 'thin-content' : content sent to AI was <500 chars after strip
 *   - 'parse-error'  : AI response wasn't parseable JSON
 *   - 'ai-timeout'   : Workers AI didn't respond within budget
 *   - 'other'        : anything else; check `error` column for detail
 */
export function classifyExtractFailure(e: unknown): string {
  if (!(e instanceof Error) || typeof e.message !== "string") return "other";
  const msg = pipelineErrorMessage(e);
  if (msg.startsWith("extract-upstream: zero-events")) return "zero-events";
  if (msg.startsWith("extract-upstream: thin-content")) return "thin-content";
  // Workers AI load timeouts surface as 'extract-network: timeout' or as
  // a step-level timeout that doesn't reach our catch. The network
  // bucket covers the former.
  if (msg.startsWith("extract-network:") && /timeout|timed.?out/i.test(msg)) return "ai-timeout";
  // OPE-1249 — the extract ROUTE caught the Workers AI timeout itself, tried the
  // deterministic salvage, and failed closed with `success:false`; submitExtract
  // carries its `aiFailure` through as `[ai: …]`.
  if (msg.startsWith("extract-upstream: ") && /\[ai: [^\]]*timed.?out/i.test(msg))
    return "ai-timeout";
  if (msg.startsWith("extract-upstream: ") && /parse|json/i.test(msg)) return "parse-error";
  return "other";
}

/** The submit leg's "AI found no events" failure, wherever the step put it. */
export function isZeroEventsFailure(e: unknown): boolean {
  return pipelineErrorMessage(e).startsWith("extract-upstream: zero-events");
}
