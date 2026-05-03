/**
 * Cloudflare Queues message schemas. Shared between the main app (producer)
 * and the MCP server (consumer) — keeping types in lockstep is what makes
 * the queue's eventual-consistency safe.
 *
 * Cap: Cloudflare Queues allow 128KB per message. We're well under for both
 * email (HTML body is the biggest field; capped via the email template) and
 * IndexNow (URL strings, very small).
 */

/** A transactional email to send via Resend. */
export type EmailJobMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Override the From line (defaults to support@meetmeatthefair.com). */
  from?: string;
  /** Free-form label for audit logs ("registration", "password-reset", etc.). */
  source: string;
};

/** A request to ping IndexNow for one or more URLs. */
export type IndexNowMessage = {
  urls: string[];
  /** Lifecycle event label: "event-create", "vendor-update", etc. */
  source: string;
};
