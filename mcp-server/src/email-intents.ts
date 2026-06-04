/**
 * Inbound email intent routing — pure-function map from recipient
 * address to a business intent. The Worker's email() entrypoint uses
 * this to decide:
 *   1. Which per-intent handler the InboundEmailWorkflow's `dispatch`
 *      step will call (mcp-server/src/email-handlers/<intent>.ts)
 *   2. Whether to message.forward() to the admin Gmail synchronously
 *      before workflow creation (some intents are admin-only;
 *      `submit` lands in D1 only, never forwarded)
 *
 * Intentionally a static map rather than CF's `routeAgentEmail` +
 * `createAddressBasedEmailResolver`. Reasons:
 *   - That framework couples each address to an Agent class (Durable
 *     Object), one DO per address. Our Workflow-based architecture is
 *     cleaner without dragging Agents in.
 *   - Our address list is small and stable; a pure-function map is the
 *     simplest thing that could work + is trivially vitest-testable.
 *
 * Add a new intent? Three steps:
 *   1. Add to EmailIntent union below
 *   2. Add entry to INTENT_MAP
 *   3. Create mcp-server/src/email-handlers/<intent>.ts implementing
 *      the HandlerResult contract from ./email-handlers/types.ts
 *   4. (in CF dashboard) Add an Email Routing rule for the new address
 *      → meetmeatthefair-mcp Worker
 */

export type EmailIntent =
  // ----- Pre-classifier address-based values (drizzle/0072) -----
  | "submit" // event submissions; legacy alias for new_event for the submit@ address path
  | "correction" // sender claims an event listing is wrong
  | "support" // general questions; covers support@ and hello@
  | "press" // media inquiries
  | "unsubscribe" // newsletter opt-out (actually flips the DB row)
  | "unknown" // catch-all; any recipient address not matched
  // ----- Classifier-only values (drizzle/0079) -----
  | "new_event" // post-classifier name for `submit` semantics; same workflow branch
  | "source_suggestion" // sender points us at a website/feed as a potential events source
  | "claim_request" // organizer claiming ownership of a listing
  | "vendor_inquiry" // vendor asking about listing/applications/profile
  | "spam" // quarantine — no auto-reply, no admin forward
  | "unclear" // confidence below threshold; admin triage
  | "multi" // parent of a multi-intent split (children carry the real intent)
  // ----- UR1 Phase 1 (2026-06-04) — user problem-report intake -----
  // `report@` and `feedback@` route here unconditionally. The classifier
  // can also tag misrouted reports landing on `support@` as
  // problem_report when the body matches problem-language keywords
  // ("broken", "doesn't work", "error", "404", "page won't load").
  | "problem_report";

const INTENT_MAP: Record<string, EmailIntent> = {
  "submit@meetmeatthefair.com": "submit",
  "corrections@meetmeatthefair.com": "correction",
  "support@meetmeatthefair.com": "support",
  "hello@meetmeatthefair.com": "support",
  "press@meetmeatthefair.com": "press",
  "unsubscribe@meetmeatthefair.com": "unsubscribe",
  // UR1 Phase 1 — dedicated problem-report intake addresses. Add Email
  // Routing rules in CF dashboard for both addresses → mcp Worker.
  "report@meetmeatthefair.com": "problem_report",
  "feedback@meetmeatthefair.com": "problem_report",
};

/**
 * Map a classifier intent to a workflow-dispatch intent. The workflow's
 * dispatch table is keyed on the legacy 6-value union; this collapses the
 * 11-value classifier output onto that surface so the existing
 * email-handlers/<intent>.ts modules keep working unchanged.
 *
 * - `new_event` → `submit` (existing 3-leg submit pipeline)
 * - `source_suggestion` → `correction` (admin_actions audit + admin review;
 *   true 3-tier dedup against discovery_candidates is C.8 follow-up work)
 * - `claim_request` / `vendor_inquiry` → `support` (manual admin response
 *   until the unified vendor-tier launch wires dedicated handlers)
 * - `spam` → handled at the entrypoint (no workflow create); this mapping
 *   only fires if admin reclassifies → spam after the fact
 * - `unclear` → `unknown` (admin triage path)
 * - `multi` → `unknown` (parent row never dispatches; children carry the
 *   real intent)
 */
export function toWorkflowIntent(intent: EmailIntent): EmailIntent {
  switch (intent) {
    case "new_event":
      return "submit";
    case "source_suggestion":
    case "claim_request":
      return "correction";
    case "vendor_inquiry":
      return "support";
    case "spam":
    case "unclear":
    case "multi":
      return "unknown";
    default:
      return intent;
  }
}

/**
 * Resolve a recipient address to an intent. Case-insensitive,
 * whitespace-tolerant. Unknown addresses fall through to "unknown" —
 * never throws, always returns a valid intent.
 */
export function resolveIntent(toAddress: string): EmailIntent {
  const normalized = toAddress.toLowerCase().trim();
  return INTENT_MAP[normalized] ?? "unknown";
}

/**
 * Should the Worker's email() entrypoint call message.forward() to the
 * admin Gmail (SUBMIT_ADMIN_FORWARD env var)?
 *
 * - `submit` does NOT forward — submissions land as events.status=PENDING
 *   in D1 and are reviewed in the admin UI; forwarding would duplicate.
 * - Every other intent (including `unknown`) forwards so the admin
 *   inbox has a copy of the original message context.
 *
 * Must be called synchronously in the email() handler before it returns
 * — the ForwardableEmailMessage object's lifecycle ends with the
 * handler. The workflow can't forward later.
 */
export function shouldForwardToAdmin(intent: EmailIntent): boolean {
  return intent !== "submit";
}
