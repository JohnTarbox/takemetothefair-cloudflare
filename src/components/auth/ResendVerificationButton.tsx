"use client";

import { useState } from "react";
import { Mail, Check, AlertCircle } from "lucide-react";

interface Props {
  /**
   * Optional pre-filled email. When set, the component shows just a
   * button — the email is sent with the request. When omitted, the
   * component renders an email input first so anonymous users (who
   * landed on a dead verification link from email) can request a
   * fresh one without first signing in.
   *
   * The `/api/auth/send-verification` endpoint accepts both shapes —
   * it prefers the authenticated session if present and falls back
   * to the body's email otherwise. It also returns the same generic
   * `{ok: true}` for non-existent emails, so the UI here doesn't
   * leak account-existence either way.
   */
  email?: string;
  /** Variant string for the rendered button text. Useful when this
   *  appears inline in a paragraph vs. as a primary CTA. */
  label?: string;
}

type Status = "idle" | "sending" | "sent" | "error";

export function ResendVerificationButton({ email: prefilledEmail, label }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [email, setEmail] = useState(prefilledEmail ?? "");
  const buttonLabel = label ?? "Resend verification email";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === "sending" || status === "sent") return;
    setStatus("sending");
    try {
      const res = await fetch("/api/auth/send-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefilledEmail ? {} : { email }),
      });
      // The API returns a generic 200 OK for both "sent" and "no such
      // user" to prevent account enumeration, so we don't distinguish
      // here either. As long as the request succeeded, show a
      // success state — the user either has a fresh email on the way
      // or already knew the address was unknown.
      setStatus(res.ok ? "sent" : "error");
    } catch {
      setStatus("error");
    }
  };

  if (status === "sent") {
    return (
      <div
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-sage-50 text-sage-700 text-sm font-medium"
        role="status"
      >
        <Check className="w-4 h-4" aria-hidden="true" />
        Check your inbox — a fresh verification link is on its way.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {!prefilledEmail && (
        <div className="relative">
          <Mail
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            aria-hidden="true"
          />
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-royal focus:border-transparent"
            aria-label="Your email address"
          />
        </div>
      )}
      <button
        type="submit"
        disabled={status === "sending"}
        className="inline-flex items-center px-4 py-2 bg-royal text-white text-sm font-medium rounded-md hover:bg-navy transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {status === "sending" ? "Sending…" : buttonLabel}
      </button>
      {status === "error" && (
        <p className="inline-flex items-center gap-1.5 text-sm text-red-600" role="alert">
          <AlertCircle className="w-4 h-4" aria-hidden="true" />
          Something went wrong. Try again in a minute.
        </p>
      )}
    </form>
  );
}
