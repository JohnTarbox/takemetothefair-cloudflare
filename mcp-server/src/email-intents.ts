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
  | "submit" // event submissions; keeps the legacy submit@ behavior
  | "correction" // sender claims an event listing is wrong
  | "support" // general questions; covers support@ and hello@
  | "press" // media inquiries
  | "unsubscribe" // newsletter opt-out (actually flips the DB row)
  | "unknown"; // catch-all; any recipient address not matched

const INTENT_MAP: Record<string, EmailIntent> = {
  "submit@meetmeatthefair.com": "submit",
  "corrections@meetmeatthefair.com": "correction",
  "support@meetmeatthefair.com": "support",
  "hello@meetmeatthefair.com": "support",
  "press@meetmeatthefair.com": "press",
  "unsubscribe@meetmeatthefair.com": "unsubscribe",
};

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
