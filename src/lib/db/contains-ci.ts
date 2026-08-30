/**
 * Re-export of the canonical `containsCI`, which now lives in
 * `@takemetothefair/db-schema` so the MCP Worker can import it too.
 *
 * OPE-630: the implementation used to live HERE, inside the Next.js app. The
 * MCP Worker is a separate deploy artifact that cannot import from `src/`, so
 * the OPE-565 sweep fixed every app call site and left all ten MCP search
 * sites on raw `LIKE` — `search_events`, the tool the discovery dedup passes
 * call, still threw on any query over 48 characters. Moving the helper to the
 * shared package is what makes "fix the family" reach both artifacts.
 *
 * The full rationale (why `instr()` and not a character cap, and the measured
 * 50-char D1 ceiling) is on the implementation in that package. This file
 * stays so the ~15 existing `@/lib/db/contains-ci` imports keep working, and
 * so the CI guard's suggested fix string remains true.
 */
export { containsCI } from "@takemetothefair/db-schema";
