/**
 * OPE-1721 — the ONE way the MCP Worker puts a message on `email-jobs`.
 *
 * Cloudflare Queues refuses a message over 128 KB (error 10204). OPE-1719 made
 * the main app's `enqueueEmail` spill an oversized body to D1
 * (`spillEmailJobBody`, `email_job_bodies`) after the Nov 27 weekend
 * newsletter was refused at 136,334 bytes. This Worker had ~30 senders calling
 * `env.EMAIL_JOBS.send()` directly, so any of them whose body grows with its
 * data (queue digests, inventory notices) would have failed the same way.
 *
 * The size is checked BEFORE a DB handle is opened, so the common small send
 * costs nothing extra and needs no `DB` in tests that fake the queue.
 *
 * Guarded by `__tests__/no-raw-email-jobs-send-ope1721.test.ts`: a raw
 * `EMAIL_JOBS.send(` anywhere else in mcp-server/src fails CI.
 */
import {
  EMAIL_JOB_INLINE_LIMIT_BYTES,
  estimateQueueMessageBytes,
  spillEmailJobBody,
  type SpillableEmailJob,
} from "@takemetothefair/db-schema/email-job-body";
import { getDb } from "./db.js";

type EmailJobQueue = { send(message: never): Promise<unknown> };

/**
 * `d1` may be undefined for callers whose env type is deliberately narrow.
 * A small message never needs it; an oversized one with no DB to spill into
 * is refused here with a message that says why, instead of reaching Queues
 * and coming back as a bare 10204.
 */
export async function sendEmailJob<T extends SpillableEmailJob>(
  queue: EmailJobQueue,
  d1: D1Database | undefined,
  msg: T
): Promise<void> {
  const bytes = estimateQueueMessageBytes(msg);
  let body: T = msg;
  if (bytes > EMAIL_JOB_INLINE_LIMIT_BYTES) {
    if (!d1) {
      throw new Error(
        `email job is ~${bytes} bytes (over the ${EMAIL_JOB_INLINE_LIMIT_BYTES}-byte inline ` +
          `limit) and no DB binding was passed to spill its body; refusing to enqueue`
      );
    }
    body = await spillEmailJobBody(getDb(d1), msg);
  }
  await (queue.send as (m: T) => Promise<unknown>)(body);
}
