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
  /** OPE-151 — link back to the triggering inbound email, when there is one. */
  inboundEmailId?: string;
  /** OPE-163 — RFC 5322 threading. Set both to the inbound Message-ID when this
   *  is a reply, so the recipient's client threads it. Consumed by the MCP
   *  email-jobs consumer (sendViaCfEmail → headers). */
  inReplyTo?: string;
  references?: string;
};

/** A request to ping IndexNow for one or more URLs. */
export type IndexNowMessage = {
  urls: string[];
  /** Lifecycle event label: "event-create", "vendor-update", etc. */
  source: string;
};

/**
 * GW1.1 (2026-06-03) — one discrepancy capture event from the ingest path.
 *
 * Emitted by the main app's `/api/suggest-event/check-duplicate` route when
 * `findDuplicate` returns a stage 2–4 match and the new submission's value
 * for one of the tracked fields disagrees with the existing event's stored
 * value. The MCP consumer drains the queue and calls `captureDiscrepancy`
 * (mcp-server/src/goodwill/capture.ts), which writes one `event_discrepancies`
 * row with `detected_by='ingest_addverify'`.
 *
 * The shape mirrors `CaptureDiscrepancyArgs` in the MCP helper — the
 * consumer passes message fields through verbatim. Keep them in sync; the
 * 24-hour idempotence guard in `captureDiscrepancy` tolerates duplicate
 * consumes but a field-name mismatch silently drops the row.
 */
export type IngestDiscrepancyMessage = {
  /** Always "ingest_addverify" today — kept as a field so future GW capture
   *  paths (e.g. URL-import admin page direct-emit) can share the queue. */
  detectedBy: "ingest_addverify";
  /** UUID of the existing event the new submission was found to duplicate. */
  eventId: string;
  /** Which field the two sources disagreed about. */
  fieldClass: "date" | "venue" | "name";
  /** The existing event's stored value (normalized to string for storage). */
  authoritativeValue: string | null;
  /** Lowercased + www-stripped host of the existing event's source_url. */
  authoritativeSourceKey: string | null;
  /** Full URL of the existing event's source (raw source_url column). */
  authoritativeSourceUrl: string | null;
  /** The new submission's claimed value (normalized to string). */
  divergentValue: string | null;
  /** Lowercased + www-stripped host of the new submission's source URL. */
  divergentSourceKey: string | null;
  /** The new submission's full source URL. */
  divergentSourceUrl: string | null;
  /** Detector confidence 0..1. GW1.1 starts at 0.85 — dedup match is itself
   *  strong evidence the events are the same; the field disagreement is
   *  therefore likely a real source conflict, not a wrong-event match. */
  confidence: number;
  /** Short human-readable explanation; `${matchType}: ${fieldClass} differs`. */
  notes: string;
};

// SYN1 (2026-06-12) — a syndication trigger emitted (best-effort, after the
// mutation's batch commits) by the five venue/event/event_day write-paths.
// Canonical definition lives in the shared policy module so the MCP consumer
// imports the exact same shape; re-exported here for producer-side ergonomics.
export type { SyndicationChangeMessage } from "@takemetothefair/utils";
