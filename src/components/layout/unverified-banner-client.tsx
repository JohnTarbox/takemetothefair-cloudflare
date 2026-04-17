"use client";

import { useEffect, useState } from "react";
import { Mail, X } from "lucide-react";

interface Props {
  email: string;
}

const DISMISS_KEY = "mmatf.unverified.dismissed";

export function UnverifiedBannerClient({ email }: Props) {
  const [dismissed, setDismissed] = useState(true); // hide on SSR; reveal on hydrate
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "sent" | "error">("idle");

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* ignore */
    }
    setDismissed(false);
  }, []);

  if (dismissed) return null;

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

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
              Couldn&apos;t resend. Please try again in a moment.
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
        <button
          type="button"
          onClick={handleDismiss}
          className="text-stone-600 hover:text-stone-900 p-1 -mr-1"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
