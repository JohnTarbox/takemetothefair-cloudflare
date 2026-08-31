/**
 * OPE-626 — the two outbound-email gates, with one typed home.
 *
 * Before this, `EMAIL_REPLY_ENABLED` had no home at all: `queue-consumers.ts`
 * read it through a local interface, `reply-to-inbound-email.ts` through
 * another, `admin.ts` through a third, and `mcp-server`'s own `Env` never
 * declared it. That is a good part of why it had no single enforcement point —
 * a flag nobody can find the definition of is a flag each caller re-invents.
 *
 * ── Two flags, because there are two different decisions ──────────────────
 *
 * `EMAIL_REPLY_ENABLED` governs **operator-composed replies to a named
 * person** — the admin reply route and the `reply_to_inbound_email` tool. That
 * is what it was built for and what it keeps meaning.
 *
 * `AUTO_REPLY_ENABLED` governs the **inbound workflow's automated acks** — the
 * `reply:*` mail the pipeline sends without a human reading it. Measured over
 * 30 days to 2026-08-28: 106 sends across 19 sources, none of them gated,
 * because both direct senders call `env.EMAIL.send` and never reach the queue
 * consumer where `EMAIL_REPLY_ENABLED` is enforced. The flag stopped the two
 * paths a human reviews and passed the one nobody reviews.
 *
 * Collapsing them into one flag was considered and rejected in the 2026-08-31
 * ruling: `EMAIL_REPLY_ENABLED` reads "true" today but has moved on its own
 * (OPE-509's plaintext-var revert, OPE-648), and putting 106 customer acks
 * behind a flag that flips without notice is how a submitter stops hearing that
 * we received their email. "Low-risk templated acks" is also not true of the
 * set — `reply:no-url-prose-failed` and `reply:ok-low-body-extract` name
 * GENERATED content paths, and OPE-537 is a logged instance of this pipeline
 * writing confident wrong prose.
 *
 * ⚠️ THE DEFAULTS ARE DELIBERATELY ASYMMETRIC, and this is the load-bearing
 * detail of the whole change:
 *
 *   AUTO_REPLY_ENABLED  unset → ENABLED   (open)
 *   EMAIL_REPLY_ENABLED unset → DISABLED  (closed)
 *
 * An unset auto-reply flag must not suppress acks. "Nothing changes on deploy"
 * was a requirement of the ruling, not a hope: the failure mode being avoided
 * is silently dropping legitimate acknowledgements, and a fail-closed default
 * would do exactly that the moment this deployed, before anyone edited
 * `wrangler.toml`. The operator flag keeps its fail-closed default because an
 * operator-composed reply is a deliberate act and its absence is safe.
 *
 * Both are read as plaintext `[vars]` in `mcp-server/wrangler.toml`, NOT from
 * the dashboard: `wrangler deploy` replaces the whole `[vars]` block from the
 * committed file, so a dashboard edit is reverted by the next deploy.
 */

export interface EmailGateEnv {
  /** Operator-composed replies to a named person. Unset means DISABLED. */
  EMAIL_REPLY_ENABLED?: string;
  /** The inbound workflow's automated acks. Unset means ENABLED. */
  AUTO_REPLY_ENABLED?: string;
}

/**
 * May the inbound workflow send an automated `reply:*` acknowledgement?
 *
 * Only the exact string `"false"` closes this gate. Not `!== "true"`, which is
 * how the operator flag reads and would be wrong here: an unset or misspelled
 * value would then suppress every ack, which is the failure this ticket exists
 * to avoid rather than to cause.
 */
export function isAutoReplyEnabled(env: EmailGateEnv | undefined): boolean {
  return env?.AUTO_REPLY_ENABLED !== "false";
}

/**
 * May an operator-composed reply be delivered?
 *
 * Fail-closed: anything but the exact string `"true"` holds the mail. This
 * preserves `queue-consumers.ts`'s existing semantics exactly — it is restated
 * here so the two gates can be compared side by side rather than inferred from
 * two files that word the same idea differently.
 */
export function isOperatorReplyEnabled(env: EmailGateEnv | undefined): boolean {
  return env?.EMAIL_REPLY_ENABLED === "true";
}

/** The ledger `error` text for an ack held by the auto-reply gate. */
export const AUTO_REPLY_HELD_REASON = "auto-reply-disabled (AUTO_REPLY_ENABLED == 'false')";
