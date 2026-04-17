"use client";

import { useState } from "react";
import { Mail, Check } from "lucide-react";

export function NewsletterSignup() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === "submitting" || status === "done") return;
    setStatus("submitting");
    try {
      const res = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "footer" }),
      });
      setStatus(res.ok ? "done" : "error");
    } catch {
      setStatus("error");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <label htmlFor="newsletter-email" className="block text-sm font-medium text-white">
        Weekend fair digest
      </label>
      <p className="text-xs text-gray-400">
        One email a week — events, new vendors, and hidden gems across New England.
      </p>
      {status === "done" ? (
        <div className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-sage-50 text-sage-700 text-sm font-medium">
          <Check className="w-4 h-4" aria-hidden />
          You&apos;re on the list
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Mail
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
              aria-hidden
            />
            <input
              id="newsletter-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              aria-label="Email address"
              className="w-full pl-9 pr-3 py-2 rounded-md bg-white/10 border border-white/20 text-white placeholder:text-gray-400 text-sm focus:bg-white/15 focus:border-amber focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={status === "submitting" || !email}
            className="px-4 py-2 rounded-md bg-amber text-navy font-semibold text-sm hover:bg-amber-dark disabled:opacity-50 transition-colors"
          >
            {status === "submitting" ? "…" : "Subscribe"}
          </button>
        </div>
      )}
      {status === "error" && (
        <p className="text-xs text-red-300">Something went wrong — try again in a moment.</p>
      )}
    </form>
  );
}
