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
import type { EmailJobMessage, IndexNowMessage } from "./types";

type QueueEnv = {
  EMAIL_JOBS?: { send: (msg: unknown) => Promise<void> };
  INDEXNOW_PINGS?: { send: (msg: unknown) => Promise<void> };
};

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

  // Fallback: send synchronously. logError-on-failure is internal to
  // sendEmail so callers don't need to handle errors.
  const db = getCloudflareDb();
  await sendEmail(db, args);
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
