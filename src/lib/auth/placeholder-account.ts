/**
 * Ingestion-placeholder account classification.
 *
 * MOVED to `@takemetothefair/utils` (OPE-649). The logic did not change — this
 * file is a re-export so the existing `@/lib/auth/placeholder-account` imports
 * and their tests keep working unchanged.
 *
 * Why it had to move: the MCP Worker and the Next.js app are two separate
 * deploy artifacts that cannot import each other's `src/`, and this same
 * one-fix-two-artifacts shape has already produced three live defects
 * (containsCI reaching only the app, computePublicDates minting broken rows
 * from MCP for five weeks, a dedup note false for ten). An admin reader in the
 * MCP Worker needs this predicate; copying it would have made a fourth.
 */
export { isPlaceholderEmail, PLACEHOLDER_REFUSAL } from "@takemetothefair/utils";
