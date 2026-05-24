/**
 * Producer-side helpers — enqueue messages from the main app.
 *
 * Both helpers fall back to a synchronous direct call when the queue binding
 * isn't available (local dev, miniflare without queues configured). That
 * keeps every code path testable end-to-end without forcing developers to
 * wire up `wrangler queues` locally.
 */

import { getCloudflareEnv, getCloudflareDb } from "@/lib/cloudflare";
import { sendEmail, type SendEmailArgs } from "@/lib/email/send";
import { pingIndexNow } from "@/lib/indexnow";
import { logError } from "@/lib/logger";
import type { EmailJobMessage, IndexNowMessage } from "./types";

type QueueEnv = {
  EMAIL_JOBS?: { send: (msg: unknown) => Promise<void> };
  INDEXNOW_PINGS?: { send: (msg: unknown) => Promise<void> };
  INTERNAL_API_KEY?: string;
  /** Override for the MCP proxy URL. Defaults to the production custom
   *  domain; useful for staging / local-dev overrides. */
  MCP_SERVER_URL?: string;
};

const MCP_DEFAULT_URL = "https://mcp.meetmeatthefair.com";

/**
 * Enqueue an email for async delivery via the queue consumer (MCP worker).
 * Falls back to a synchronous Resend call when the queue binding is absent
 * (local dev / queue misconfiguration / dev preview environments).
 *
 * Returns immediately on the queue path — the caller should NOT `await`
 * delivery. If the producer needs delivery confirmation (rare for
 * transactional email), use `sendEmail` directly.
 *
 * The fall-through `sendEmail` call still goes through the existing stub +
 * Resend code path, so behavior is identical when no queue is wired up.
 */
export async function enqueueEmail(args: SendEmailArgs & { source: string }): Promise<void> {
  const env = getCloudflareEnv() as unknown as QueueEnv;

  // Path 1: direct queue binding. Works when the caller is a Worker that
  // owns the producer binding (the MCP server, for example). Cloudflare
  // Pages does NOT wire [[queues.producers]] from wrangler.toml to the
  // runtime queue registry — even when deployment_configs.queue_producers
  // is populated. Confirmed 2026-05-24 by querying the queue's actual
  // producer list. So this path silently no-ops on Pages.
  if (env.EMAIL_JOBS) {
    const msg: EmailJobMessage = {
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      from: args.from,
      source: args.source,
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
      // Non-2xx — fall through to the sync sendEmail() so we at least log
      // a stub row instead of dropping the message silently.
      const db = getCloudflareDb();
      await logError(db, {
        level: "warn",
        source: "queues:producers:enqueue-email",
        message: "MCP proxy returned non-2xx; falling back to sync sendEmail",
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
        message: "MCP proxy fetch threw; falling back to sync sendEmail",
        error: e,
        context: { callerSource: args.source },
      });
    }
  }

  // Path 3: synchronous sendEmail fallback. Logs internally on failure
  // (resend success/error or stub-warn when no key). Propagate `source`
  // so a stub-fallback row in error_logs identifies the original caller.
  const db = getCloudflareDb();
  await sendEmail(db, { ...args, source: args.source });
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
