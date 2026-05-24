"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail } from "lucide-react";

interface Props {
  email: string;
}

/**
 * Site-wide banner shown to logged-in users whose `users.email_verified`
 * is null. **Non-dismissible by design.** Previously sessionStorage-
 * dismissible, but the dismissible-X created a recovery dead-end: a
 * user who closed the banner had no in-product way back to the resend
 * trigger, which became visible in the 2026-05-24 email-outage
 * post-mortem. The banner now stays put until the user verifies, at
 * which point the wrapper server component stops rendering it.
 *
 * The "Resend" button hits `/api/auth/send-verification`, same as
 * before. A "Need help?" link points to `/verify-email/resend` so
 * non-JS users (or anyone who'd rather see a dedicated page) have a
 * clean path too.
 */
export function UnverifiedBannerClient({ email }: Props) {
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "sent" | "error">("idle");

  const handleResend = async () => {
    setResending(true);
    setResendStatus("idle");
    try {
      const res = await fetch("/api/auth/send-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setResendStatus(res.ok ? "sent" : "error");
    } catch {
      setResendStatus("error");
    } finally {
      setResending(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="Email verification required"
      className="bg-amber-light border-b border-amber-dark/20 text-stone-900"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-2.5 flex flex-wrap items-center gap-3">
        <Mail className="w-4 h-4 flex-shrink-0 text-amber-dark" aria-hidden />
        <p className="text-sm flex-1 min-w-0">
          Please verify your email <strong className="font-semibold">{email}</strong>
          {resendStatus === "sent" && (
            <span className="ml-2 text-sage-700 font-medium">
              Verification email sent. Check your inbox.
            </span>
          )}
          {resendStatus === "error" && (
            <span className="ml-2 text-danger font-medium">
              Couldn&apos;t resend.{" "}
              <Link href="/verify-email/resend" className="underline">
                Try the resend page
              </Link>
              .
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={handleResend}
          disabled={resending || resendStatus === "sent"}
          className="text-sm font-semibold text-navy hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {resending ? "Sending…" : resendStatus === "sent" ? "Sent" : "Resend email"}
        </button>
      </div>
    </div>
  );
}
