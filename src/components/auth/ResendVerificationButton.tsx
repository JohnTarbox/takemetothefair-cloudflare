"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, Check, AlertCircle } from "lucide-react";
import { readResendOutcome } from "@/lib/email/resend-result";

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

type Status = "idle" | "sending" | "sent" | "error" | "undeliverable";

export function ResendVerificationButton({ email: prefilledEmail, label }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [email, setEmail] = useState(prefilledEmail ?? "");
  const [undeliverableTo, setUndeliverableTo] = useState("");
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
      //
      // OPE-1172 — the one distinct answer is "this address cannot receive
      // mail" (a 422 that depends only on the address, not on an account).
      const outcome = await readResendOutcome(res, prefilledEmail ?? email);
      if (outcome.kind === "undeliverable") setUndeliverableTo(outcome.email);
      setStatus(outcome.kind);
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

  if (status === "undeliverable") {
    // OPE-1172 — copy approved by John 2026-09-27, verbatim. The address is
    // always shown back: the traced case was a typo before the @. There is no
    // change-email flow for unverified users, so the approved "[Update email
    // address]" button is replaced with a sign-up link, as the approval says.
    return (
      <div
        className="rounded-md border border-amber-dark/30 bg-amber-light px-4 py-3 text-sm"
        role="alert"
      >
        <p className="font-semibold text-stone-900">
          We couldn&apos;t deliver email to {undeliverableTo}.
        </p>
        <p className="mt-1 text-stone-800">
          Messages to this address are being returned as undeliverable. Please check the spelling,
          or use a different email address.
        </p>
        <p className="mt-2 text-stone-800">
          or{" "}
          <Link href="/register" className="font-medium underline">
            sign up again with the correct address
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {!prefilledEmail && (
        <div className="relative">
          <Mail
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            className="w-full pl-9 pr-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-royal focus:border-transparent"
            aria-label="Your email address"
          />
        </div>
      )}
      <button
        type="submit"
        disabled={status === "sending"}
        className="inline-flex items-center px-4 py-2 bg-secondary text-secondary-foreground text-sm font-medium rounded-md hover:bg-secondary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
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
