/**
 * Producer-side helpers — enqueue messages from the main app.
 *
 * `enqueueIndexNow` falls back to a synchronous direct ping when the queue
 * binding isn't available (local dev, miniflare without queues configured),
 * which keeps that path testable without wiring up `wrangler queues` locally.
 *
 * `enqueueEmail` does NOT. Its synchronous fallback was removed in OPE-445
 * because it routed to an unconfigured Resend and stubbed silently — see the
 * note on that function. Email now throws rather than pretending to send.
 */

import { getCloudflareEnv, getCloudflareDb } from "@/lib/cloudflare";
import { type SendEmailArgs } from "@/lib/email/send";
import { pingIndexNow } from "@/lib/indexnow";
import { logError } from "@/lib/logger";
import type {
  EmailJobMessage,
  IndexNowMessage,
  IngestDiscrepancyMessage,
  SyndicationChangeMessage,
} from "./types";

type QueueEnv = {
  EMAIL_JOBS?: { send: (msg: unknown) => Promise<void> };
  INDEXNOW_PINGS?: { send: (msg: unknown) => Promise<void> };
  EVENT_DISCREPANCIES?: { send: (msg: unknown) => Promise<void> };
  SYNDICATION_CHANGES?: { send: (msg: unknown) => Promise<void> };
  INTERNAL_API_KEY?: string;
  /** Override for the MCP proxy URL. Defaults to the production custom
   *  domain; useful for staging / local-dev overrides. */
  MCP_SERVER_URL?: string;
};

const MCP_DEFAULT_URL = "https://mcp.meetmeatthefair.com";

/**
 * Enqueue an email for async delivery via the queue consumer (MCP worker).
 *
 * Two transports, tried in order: the direct `EMAIL_JOBS` binding, then an
 * HTTP proxy to the MCP Worker. If neither is available this THROWS — it does
 * not fall back to a synchronous send.
 *
 * OPE-445 removed that fallback. It called `sendEmail` → Resend, and
 * `RESEND_API_KEY` is configured nowhere, so it always took its stub branch:
 * an `email_send_ledger` row with `status='stubbed'`, `error=NULL`, and a
 * normal return. Indistinguishable from success to every caller. That is how
 * 26 consecutive `indexnow:health` alerts were lost over a month (OPE-369).
 *
 * Do NOT reintroduce a silent fallback here, and do NOT route new senders
 * through `sendEmail` directly to "avoid the queue" — that is the same dark
 * path by another name. If you need delivery confirmation, read
 * `email_send_ledger` (and `delivery_status`, since OPE-177).
 *
 * Returns immediately on the queue path — the caller should NOT `await`
 * delivery.
 */
export async function enqueueEmail(args: SendEmailArgs & { source: string }): Promise<void> {
  const env = getCloudflareEnv() as unknown as QueueEnv;

  // Path 1: direct queue binding — the NORMAL path on this stack.
  //
  // OPE-445 corrected this comment. It used to end "so this path silently
  // no-ops on Pages", which was true of the pre-2026-06-10 Pages deployment
  // and has been wrong ever since the OpenNext cutover: we run as the
  // `meetmeatthefair-app` Worker, where `[[queues.producers]]` in wrangler.toml
  // IS a first-class binding.
  //
  // The stale wording was not cosmetic — the OPE-369 author recorded nearly
  // abandoning a correct fix because of it ("had I trusted the comment I would
  // have concluded my own fix was a no-op"). A comment that would have caused a
  // working change to be reverted is a defect in its own right.
  if (env.EMAIL_JOBS) {
    const msg: EmailJobMessage = {
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      from: args.from,
      source: args.source,
      inboundEmailId: args.inboundEmailId,
      inReplyTo: args.inReplyTo,
      references: args.references,
      // OPE-385 — one-click unsubscribe. Forwarded, not synthesised here: the
      // caller owns the per-recipient signed token.
      listUnsubscribe: args.listUnsubscribe,
      listUnsubscribePost: args.listUnsubscribePost,
    };
    await env.EMAIL_JOBS.send(msg);
    return;
  }

  // Path 2: HTTP proxy to the MCP Worker, which DOES have a working queue
  // producer binding. Authenticated via X-Internal-Key, same pattern as
  // the existing inbound-emails admin endpoints. Adds ~50-100ms hop, but
  // the actual delivery is async through the queue consumer so this
  // doesn't affect user-facing latency on the calling endpoint.
  if (env.INTERNAL_API_KEY) {
    const url = `${env.MCP_SERVER_URL || MCP_DEFAULT_URL}/api/admin/internal/enqueue-email`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": env.INTERNAL_API_KEY,
        },
        body: JSON.stringify(args),
      });
      if (res.ok) return;
      // Non-2xx — no transport left. Log it here, then fall through to the
      // throw below (OPE-445): there is no longer a silent stub fallback.
      const db = getCloudflareDb();
      await logError(db, {
        level: "warn",
        source: "queues:producers:enqueue-email",
        message: "MCP proxy returned non-2xx; no transport left, enqueueEmail will throw",
        context: {
          status: res.status,
          callerSource: args.source,
        },
      });
    } catch (e) {
      const db = getCloudflareDb();
      await logError(db, {
        level: "warn",
        source: "queues:producers:enqueue-email",
        message: "MCP proxy fetch threw; no transport left, enqueueEmail will throw",
        error: e,
        context: { callerSource: args.source },
      });
    }
  }

  // OPE-445 — Path 3 used to be a synchronous `sendEmail()` fallback. It has
  // been removed, because it could not send and did not say so.
  //
  // `sendEmail` routes to Resend, and `RESEND_API_KEY` is set NOWHERE — not in
  // wrangler.toml, not .env.example, not as a Worker secret. So that path has
  // always taken its stub branch: it wrote an `email_send_ledger` row with
  // `status='stubbed'` and `error=NULL`, then returned normally. To every
  // caller that looked exactly like a successful send.
  //
  // That is how `indexnow:health` produced 26 consecutive stubbed alerts
  // between 2026-07-10 and 2026-08-10 (OPE-369). The alert that warns us an
  // integration has gone silent was itself silent for a month, and the ledger
  // row it left behind looked benign.
  //
  // Deleting the call outright would be worse: reaching here would then return
  // quietly having done nothing at all. So this fails LOUDLY instead — an
  // error-level log (durable, written at the moment of failure rather than
  // discovered by a later sweep) and a throw.
  //
  // Reaching this point means BOTH real paths are unavailable: no EMAIL_JOBS
  // binding AND no working MCP proxy. On Workers that is a genuine
  // misconfiguration, not a routine fallback.
  const db = getCloudflareDb();
  const detail =
    `enqueueEmail could not reach any working transport: ` +
    `EMAIL_JOBS binding ${env.EMAIL_JOBS ? "present" : "absent"}, ` +
    `INTERNAL_API_KEY ${env.INTERNAL_API_KEY ? "present (proxy failed)" : "absent"}. ` +
    `Mail was NOT sent.`;
  await logError(db, {
    level: "error",
    source: "queues:producers:enqueue-email",
    message: detail,
    context: { callerSource: args.source, to: args.to, subject: args.subject },
  });
  throw new Error(`${detail} (source: ${args.source})`);
}

/**
 * Enqueue an IndexNow ping for async submission to Bing.
 *
 * The consumer batches messages — multiple producer calls within the
 * batch_timeout window aggregate into one Bing API submit (up to 10k URLs
 * per batch per Bing's spec). That's the main win over direct calls:
 * a bulk import that touches 200 vendors no longer makes 200 sequential
 * ping calls.
 *
 * Falls back to synchronous direct ping when the queue binding is absent.
 */
export async function enqueueIndexNow(urls: string | string[], source: string): Promise<void> {
  const list = Array.isArray(urls) ? urls : [urls];
  if (list.length === 0) return;

  const env = getCloudflareEnv() as unknown as QueueEnv & {
    INDEXNOW_KEY?: string;
  };

  if (env.INDEXNOW_PINGS) {
    const msg: IndexNowMessage = { urls: list, source };
    await env.INDEXNOW_PINGS.send(msg);
    return;
  }

  // Fallback: ping synchronously via the existing helper.
  const db = getCloudflareDb();
  await pingIndexNow(db, list, env, source);
}

/**
 * GW1.1 (2026-06-03) — enqueue one ingest_addverify discrepancy capture.
 *
 * Fired from `/api/suggest-event/check-duplicate` when `findDuplicate`
 * matches stages 2-4 and the new submission's value for a tracked field
 * disagrees with the existing event's stored value. The MCP consumer
 * drains the queue and calls `captureDiscrepancy` to write one
 * `event_discrepancies` row per message.
 *
 * Following the same 3-path shape as `enqueueEmail`:
 *
 *   1. Direct queue binding — no-op at runtime on Pages (see the comment
 *      on `enqueueEmail`), but kept for shape consistency and for the
 *      future Workers-on-Pages migration.
 *   2. HTTP proxy to the MCP Worker's /api/admin/internal/enqueue-
 *      discrepancy endpoint. INTERNAL_API_KEY auth, same pattern as the
 *      email enqueue proxy.
 *   3. Log-only fallback. No sync fallback exists because the
 *      captureDiscrepancy helper lives in MCP-only code and the
 *      event_discrepancies table is the one piece of goodwill state we
 *      don't want main app to write directly (the 24-hr idempotence
 *      guard and notes formatting are encapsulated in the helper).
 *
 * Never throws — the caller should wrap in `ctx.waitUntil` and treat as
 * fire-and-forget. Errors get logged via the standard error_logs path.
 */
export async function enqueueIngestDiscrepancy(msg: IngestDiscrepancyMessage): Promise<void> {
  const env = getCloudflareEnv() as unknown as QueueEnv;

  // Path 1: direct binding (no-op on Pages, kept for shape parity).
  if (env.EVENT_DISCREPANCIES) {
    try {
      await env.EVENT_DISCREPANCIES.send(msg);
      return;
    } catch (e) {
      const db = getCloudflareDb();
      await logError(db, {
        level: "warn",
        source: "queues:producers:enqueue-discrepancy",
        message: "EVENT_DISCREPANCIES.send threw; falling through to HTTP proxy",
        error: e,
        context: { eventId: msg.eventId, fieldClass: msg.fieldClass },
      });
    }
  }

  // Path 2: HTTP proxy via the MCP Worker. Same pattern as enqueueEmail.
  if (env.INTERNAL_API_KEY) {
    const url = `${env.MCP_SERVER_URL || MCP_DEFAULT_URL}/api/admin/internal/enqueue-discrepancy`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": env.INTERNAL_API_KEY,
        },
        body: JSON.stringify(msg),
      });
      if (res.ok) return;
      const db = getCloudflareDb();
      await logError(db, {
        level: "warn",
        source: "queues:producers:enqueue-discrepancy",
        message: "MCP proxy returned non-2xx; dropping discrepancy",
        context: {
          status: res.status,
          eventId: msg.eventId,
          fieldClass: msg.fieldClass,
        },
      });
      return;
    } catch (e) {
      const db = getCloudflareDb();
      await logError(db, {
        level: "warn",
        source: "queues:producers:enqueue-discrepancy",
        message: "MCP proxy fetch threw; dropping discrepancy",
        error: e,
        context: { eventId: msg.eventId, fieldClass: msg.fieldClass },
      });
      return;
    }
  }

  // Path 3: no INTERNAL_API_KEY (local dev without secret). Log and drop.
  const db = getCloudflareDb();
  await logError(db, {
    level: "warn",
    source: "queues:producers:enqueue-discrepancy",
    message: "no EVENT_DISCREPANCIES binding and no INTERNAL_API_KEY; dropping",
    context: { eventId: msg.eventId, fieldClass: msg.fieldClass },
  });
}

/**
 * SYN1 (2026-06-12) — enqueue a syndication trigger for an entity whose
 * mirrored fields just changed. Best-effort + NEVER throws: the durable
 * `syndication_outbox` row was already written in the mutation's batch, so a
 * dropped enqueue only delays delivery (a future enqueue for the same entity,
 * or an operator drain, still picks up the unprocessed row). The caller must
 * NOT let syndication failures fail the underlying correction.
 *
 * Post-OpenNext the main app runs on Workers, where `[[queues.producers]]` is
 * first-class — so the direct binding path is the live one. No MCP HTTP proxy
 * fallback (unlike enqueueEmail): if the binding is somehow absent we log and
 * move on rather than add a synchronous cross-Worker hop to the edit latency.
 */
export async function enqueueSyndicationChange(msg: SyndicationChangeMessage): Promise<void> {
  try {
    const env = getCloudflareEnv() as unknown as QueueEnv;
    if (env.SYNDICATION_CHANGES) {
      await env.SYNDICATION_CHANGES.send(msg);
      return;
    }
    const db = getCloudflareDb();
    await logError(db, {
      level: "warn",
      source: "queues:producers:enqueue-syndication",
      message: "SYNDICATION_CHANGES binding absent; outbox row left for drain backstop",
      context: { entityType: msg.entityType, entityId: msg.entityId },
    });
  } catch (e) {
    try {
      const db = getCloudflareDb();
      await logError(db, {
        level: "warn",
        source: "queues:producers:enqueue-syndication",
        message: "enqueueSyndicationChange threw; swallowed (outbox row durable)",
        error: e,
        context: { entityType: msg.entityType, entityId: msg.entityId },
      });
    } catch {
      // Last-resort: never propagate.
    }
  }
}
