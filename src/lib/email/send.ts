import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logError } from "@/lib/logger";
import { SITE_URL, SUPPORT_EMAIL } from "@takemetothefair/constants";
import { formatRecipientsForLedger, normalizeRecipients } from "@takemetothefair/utils";
import { emailSendLedger } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  /**
   * Optional caller identifier — surfaces in error_logs context so a stub
   * row tells you WHICH endpoint stubbed. Drove the 2026-05-24
   * email-outage diagnosis: 30 days of stubs landed at level=info with
   * no source-of-call breadcrumb, so the impact analysis had to be
   * reconstructed from subject-line guessing. Callers that go through
   * `enqueueEmail` already carry a source field — this propagates it
   * through the synchronous fallback path.
   */
  source?: string;
  /** OPE-151 — link back to the triggering inbound email, when there is one. */
  inboundEmailId?: string;
  /** OPE-163 — RFC 5322 threading for replies. Both set to the inbound
   *  Message-ID so the recipient's client threads our reply. Applied as
   *  In-Reply-To / References headers on the Resend path and forwarded through
   *  the queue path (EmailJobMessage) to the CF-email consumer. */
  inReplyTo?: string;
  references?: string;
}

/**
 * OPE-151 — write one email_send_ledger row per direct-send attempt so the
 * main-app Resend path is auditable (it previously wrote nothing). Best-effort:
 * a ledger failure (or a null db) must never affect the send outcome. Direct
 * sends get a generated `direct-<uuid>` id, so there's never a key conflict.
 */
async function ledgerDirectSend(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  args: SendEmailArgs,
  outcome: {
    status: "sent" | "failed" | "stubbed";
    provider: "resend" | "stub";
    providerMessageId?: string | null;
    error?: string | null;
  }
): Promise<void> {
  if (!db) return;
  try {
    await db.insert(emailSendLedger).values({
      messageId: `direct-${crypto.randomUUID()}`,
      sentAt: new Date(),
      // OPE-261 — a multi-recipient alert records the full list, not just the
      // first address.
      recipient: formatRecipientsForLedger(args.to),
      source: args.source ?? null,
      subject: args.subject,
      status: outcome.status,
      provider: outcome.provider,
      providerMessageId: outcome.providerMessageId ?? null,
      error: outcome.error ?? null,
      inboundEmailId: args.inboundEmailId ?? null,
      bodyHtml: args.html,
      bodyText: args.text,
    });
  } catch {
    /* ledger is best-effort — never affect the send outcome */
  }
}

export type SendResult =
  | { ok: true; provider: "resend" | "stub" }
  | { ok: false; provider: "resend"; error: string };

function getRuntimeEnv(key: string): string | undefined {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as Record<string, string | undefined>)[key];
  } catch {
    return process.env[key];
  }
}

async function sendViaResend(
  args: SendEmailArgs,
  apiKey: string
): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  const from = args.from ?? `Meet Me at the Fair <${SUPPORT_EMAIL}>`;
  // OPE-163 — threading headers for replies (Resend passes custom headers through).
  const threadHeaders: Record<string, string> = {};
  if (args.inReplyTo) threadHeaders["In-Reply-To"] = args.inReplyTo;
  if (args.references) threadHeaders["References"] = args.references;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        // OPE-261 — Resend's `to` accepts string[]; a comma-separated string
        // would be one malformed address. Mirrors the cf-email queue path.
        to: normalizeRecipients(args.to),
        subject: args.subject,
        html: args.html,
        text: args.text,
        ...(Object.keys(threadHeaders).length > 0 ? { headers: threadHeaders } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<empty>");
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 500)}` };
    }
    // Resend returns { id: "<uuid>" } — capture it for the ledger (best-effort).
    const json = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: json?.id ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Send a transactional email.
 *
 * - If RESEND_API_KEY is set in the runtime env, delivers via Resend.
 * - Otherwise, logs the full email (including body) to `error_logs` with
 *   source=`email:stub` at level=info so an admin can view it and manually
 *   deliver the reset/verification link in the interim.
 *
 * This fallback lets the UX ship before an email provider is configured;
 * password reset flows don't break — the admin just needs to watch the log.
 */
export async function sendEmail(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  args: SendEmailArgs
): Promise<SendResult> {
  const apiKey = getRuntimeEnv("RESEND_API_KEY");

  if (apiKey) {
    const result = await sendViaResend(args, apiKey);
    if (result.ok) {
      await ledgerDirectSend(db, args, {
        status: "sent",
        provider: "resend",
        providerMessageId: result.id,
      });
      return { ok: true, provider: "resend" };
    }
    await ledgerDirectSend(db, args, {
      status: "failed",
      provider: "resend",
      error: result.error,
    });
    await logError(db, {
      level: "warn",
      message: `Resend send failed, content logged for manual delivery`,
      source: "email:resend",
      context: {
        to: args.to,
        subject: args.subject,
        error: result.error,
        text: args.text,
      },
    });
    return { ok: false, provider: "resend", error: result.error };
  }

  // Bumped from info to warn after the 2026-04-25 → 2026-05-24 silent
  // outage. Every transactional email since that date was stubbed
  // because RESEND_API_KEY wasn't set on Pages AND the EMAIL_JOBS queue
  // binding wasn't wired up (the producer never reached the consumer
  // that actually delivers via CF Email Sending). info-level meant
  // nothing alerted; warn surfaces in the standard error_logs dashboards
  // and trips the new /api/admin/email-stub-check sweep.
  await logError(db, {
    level: "warn",
    message: `[email:stub] ${args.subject} → ${args.to}${args.source ? ` (source=${args.source})` : ""}`,
    source: "email:stub",
    context: {
      to: args.to,
      subject: args.subject,
      callerSource: args.source ?? null,
      text: args.text,
      html: args.html,
    },
  });
  await ledgerDirectSend(db, args, { status: "stubbed", provider: "stub" });
  return { ok: true, provider: "stub" };
}

/**
 * Resolve the public site URL for constructing absolute links in emails.
 * Priority: NEXT_PUBLIC_SITE_URL env override → production apex (SITE_URL).
 *
 * Deliberately does NOT derive the host from the incoming request. This guards
 * against a request-derived host leaking into verification / password-reset /
 * newsletter-confirm email links — a live regression during the K2 era, when
 * the apex was fronted by a proxy Worker and the request host was the Pages
 * origin `takemetothefair.pages.dev` (that proxy was deleted in B5, 2026-06-12;
 * OpenNext now serves the apex directly). Pinning to SITE_URL stays correct
 * regardless of topology — and across staging/preview hosts where a
 * request-derived origin would still be wrong. Set the env override for local
 * dev / staging hosts.
 */
export function getSiteUrl(): string {
  const override = getRuntimeEnv("NEXT_PUBLIC_SITE_URL");
  if (override) return override.replace(/\/$/, "");
  return SITE_URL;
}
