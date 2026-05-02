import { getRequestContext } from "@cloudflare/next-on-pages";
import { logError } from "@/lib/logger";
import { SITE_URL, SUPPORT_EMAIL } from "@takemetothefair/constants";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
}

export type SendResult =
  | { ok: true; provider: "resend" | "stub" }
  | { ok: false; provider: "resend"; error: string };

function getRuntimeEnv(key: string): string | undefined {
  try {
    const { env } = getRequestContext();
    return (env as unknown as Record<string, string | undefined>)[key];
  } catch {
    return process.env[key];
  }
}

async function sendViaResend(
  args: SendEmailArgs,
  apiKey: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const from = args.from ?? `Meet Me at the Fair <${SUPPORT_EMAIL}>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<empty>");
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 500)}` };
    }
    return { ok: true };
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
      return { ok: true, provider: "resend" };
    }
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

  await logError(db, {
    level: "info",
    message: `[email:stub] ${args.subject} → ${args.to}`,
    source: "email:stub",
    context: {
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    },
  });
  return { ok: true, provider: "stub" };
}

/**
 * Resolve the public site URL for constructing absolute links in emails.
 * Priority: NEXT_PUBLIC_SITE_URL env → incoming request origin → production fallback.
 */
export function getSiteUrl(request?: Request): string {
  const override = getRuntimeEnv("NEXT_PUBLIC_SITE_URL");
  if (override) return override.replace(/\/$/, "");
  if (request) {
    try {
      const url = new URL(request.url);
      return `${url.protocol}//${url.host}`;
    } catch {
      /* fall through */
    }
  }
  return SITE_URL;
}
