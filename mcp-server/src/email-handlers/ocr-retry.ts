/**
 * Moved to `@takemetothefair/utils` by OPE-297 — the main app's image-intake
 * lane needs the same retry semantics, and two copies of a cold-start policy
 * is exactly the drift OPE-285 was about.
 *
 * Kept as a re-export so existing call sites and tests are untouched.
 */
export {
  isTransientAiError,
  toMarkdownWithRetry,
  type ToMarkdownAi,
  type ToMarkdownDoc,
  type ToMarkdownOutcome,
  type ToMarkdownResult,
} from "@takemetothefair/utils";
