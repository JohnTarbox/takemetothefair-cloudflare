"use client";

import { useId, useState } from "react";
import { Mail, Check } from "lucide-react";
import { trackFormSubmit } from "@/lib/analytics";
import { NEWSLETTER_NAME, VENDOR_NEWSLETTER_NAME } from "@/lib/newsletter-masthead";

/**
 * OPE-1209 — which newsletter a form signs up for.
 *
 * The list is decided server-side from `source` alone
 * (`listForSource`: exactly "vendor-form" → vendor, anything else → weekend), so
 * a vendor form MUST post that exact source. `audience` is how a surface asks
 * for the vendor form; it fixes the source rather than trusting each caller to
 * spell it, and it fixes the name and copy with it, so a form can never read
 * "New This Week" while posting to the weekend list, or the reverse.
 */
export type SignupAudience = "weekend" | "vendor";
export const VENDOR_SIGNUP_SOURCE = "vendor-form";

const COPY: Record<SignupAudience, { name: string; blurb: string }> = {
  weekend: {
    name: NEWSLETTER_NAME,
    blurb:
      "One email a week — the best fairs and festivals across New England, plus new vendors and hidden gems.",
  },
  vendor: {
    name: VENDOR_NEWSLETTER_NAME,
    blurb:
      "For exhibitors: New England shows newly added to the site, with booth space still open — one email a week, free.",
  },
};

/**
 * OPE-317 — `source` is a prop, not a constant.
 *
 * It was hardcoded "footer", which was fine while the footer was the only
 * placement. With the same form on event pages, blog posts and archives, a
 * fixed value would make every signup look like a footer signup and hide which
 * surface actually converts — the one thing the growth target needs to know.
 */
/**
 * OPE-1209 (rework 2026-10-04) — the form was styled ONLY for the dark footer
 * (`text-footer-foreground`, light text). OPE-317 then placed it on light
 * surfaces — the in-page block on every event page and blog post, /newsletter,
 * and later /vendors — where its label, blurb and typed email rendered
 * near-white on cream, and inside the block the label and blurb also
 * DUPLICATED the card's own heading. Seen in a real browser 2026-10-04.
 *
 * `tone="surface"` uses the page's foreground tokens. `showIntro={false}` is
 * for a container that already shows the name and blurb: the label stays for
 * screen readers (sr-only), the blurb is dropped. Footer behaviour unchanged.
 */
export type SignupTone = "footer" | "surface";

const TONE: Record<SignupTone, { label: string; blurb: string; icon: string; input: string }> = {
  footer: {
    label: "text-footer-foreground",
    blurb: "text-footer-foreground/70",
    icon: "text-footer-foreground/70",
    input:
      "bg-footer-foreground/10 border-footer-foreground/20 text-footer-foreground placeholder:text-footer-foreground/60 focus:bg-footer-foreground/15",
  },
  surface: {
    label: "text-foreground",
    blurb: "text-muted-foreground",
    icon: "text-muted-foreground",
    input: "bg-background border-border text-foreground placeholder:text-muted-foreground",
  },
};

export function NewsletterSignup({
  source: sourceProp = "footer",
  audience = "weekend",
  tone = "footer",
  showIntro = true,
}: {
  source?: string;
  audience?: SignupAudience;
  tone?: SignupTone;
  showIntro?: boolean;
} = {}) {
  const t = TONE[tone];
  const source = audience === "vendor" ? VENDOR_SIGNUP_SOURCE : sourceProp;
  const copy = COPY[audience];
  // Two forms can share a page (an in-page block plus the footer), so the
  // label/input pairing needs a per-instance id, not a fixed one.
  const inputId = useId();
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
        body: JSON.stringify({ email, source }),
      });
      setStatus(res.ok ? "done" : "error");
      // ENG1.3 (2026-06-09) — fire AFTER res.ok so failed POSTs don't
      // inflate the signup counter. Newsletter has no pre-existing
      // GA4 event, so the beacon side mirrors to D1 (via the helper)
      // for immediate /admin/analytics visibility.
      if (res.ok) {
        trackFormSubmit("newsletter", { source });
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2" data-newsletter-audience={audience}>
      <label
        htmlFor={inputId}
        className={showIntro ? `block text-sm font-medium ${t.label}` : "sr-only"}
      >
        {copy.name}
      </label>
      {showIntro && <p className={`text-xs ${t.blurb}`}>{copy.blurb}</p>}
      {status === "done" ? (
        <div className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-sage-50 text-sage-700 text-sm font-medium">
          <Check className="w-4 h-4" aria-hidden />
          You&apos;re on the list
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Mail
              className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${t.icon}`}
              aria-hidden
            />
            <input
              id={inputId}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              aria-label="Email address"
              className={`w-full pl-9 pr-3 py-2 rounded-md border text-sm focus:border-amber focus:outline-none ${t.input}`}
            />
          </div>
          <button
            type="submit"
            disabled={status === "submitting" || !email}
            // Contrast follow-up (2026-06-07) — text-navy on bg-amber is
            // 5.4:1 light / 1.12:1 dark (unreadable). text-primary-foreground
            // (#1F1A0A always) gives 9.7:1 AAA in both themes.
            className="px-4 py-2 rounded-md bg-amber text-primary-foreground font-semibold text-sm hover:bg-amber-dark disabled:opacity-50 transition-colors"
          >
            {status === "submitting" ? "…" : "Subscribe"}
          </button>
        </div>
      )}
      {status === "error" && (
        // Dark-mode closeout (2026-06-08) — last untokenized error color
        // in the codebase. Pre-fix `text-red-300` on the footer's
        // bg-secondary surface was 4.4:1 in light (borderline AA) and
        // 1.6:1 in dark (basically invisible — lifted-blue + soft-pink).
        // Migrated to a Badge variant="danger" pill which uses the
        // --danger-soft + --danger-soft-foreground pair (AAA in both
        // themes by design).
        <div className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-danger-soft text-danger-soft-foreground">
          Something went wrong — try again in a moment.
        </div>
      )}
    </form>
  );
}
