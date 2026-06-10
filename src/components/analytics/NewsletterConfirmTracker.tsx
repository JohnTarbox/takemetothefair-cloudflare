"use client";

import { useEffect } from "react";
import { trackNewsletterConfirm } from "@/lib/analytics";

/**
 * ENG1.7 (Dev-Email-2026-06-10 §B, 2026-06-10) — fires `newsletter_confirm`
 * once when the double-opt-in confirmation link lands on /newsletter/confirmed
 * with a successful status. Server route does the token consume + redirect;
 * this client child reports the conversion. "already_confirmed" is excluded —
 * it's not a fresh confirmation.
 */
export function NewsletterConfirmTracker({ status }: { status?: string }) {
  useEffect(() => {
    if (status === "ok") trackNewsletterConfirm();
  }, [status]);

  return null;
}
