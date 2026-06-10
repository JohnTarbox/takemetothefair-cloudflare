"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { trackVendorClaim } from "@/lib/analytics";

interface Props {
  claimed: boolean;
  /** Vendor row id — sent as the `vendor_id` claim-funnel param when known. */
  vendorId?: string;
  /**
   * The vendor row's listed contact_email. When this matches the
   * signed-in user's verified email, the widget renders a one-click
   * "Claim now" button that hits /api/vendor/claim/direct — no
   * separate confirmation email needed (the verification step already
   * proved control of the same mailbox). When emails differ, falls
   * back to the standard two-step flow via /api/vendor/claim/initiate.
   */
  vendorContactEmail?: string | null;
  /** The vendor's slug — required to call the direct claim endpoint. */
  vendorSlug?: string;
  onClaimed?: () => void;
}

const ERROR_LABELS: Record<string, string> = {
  missing_token: "Missing token in confirmation link.",
  not_found: "That confirmation link is no longer valid.",
  expired: "That confirmation link has expired. Request a new one.",
  wrong_account: "Please sign in with the account that requested the claim.",
  server: "Something went wrong on our side. Try again or contact support.",
};

function emailMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Vendor self-serve claim CTA. Two paths:
 *   - **Direct claim** (when user.email matches vendor.contact_email):
 *     one-click POST to /api/vendor/claim/direct, no email round-trip.
 *   - **Email round-trip** (when emails differ): the original flow —
 *     POST /api/vendor/claim/initiate sends a confirmation email,
 *     user clicks the link → /api/vendor/claim/confirm.
 *
 * The widget reads useSession() to compare the user's email to the
 * vendor's contact_email it was passed. Also reads `?claimed=1` and
 * `?claim_error=<reason>` from the post-redirect URL (set by the
 * /confirm endpoint) and surfaces them, then strips the params.
 */
export function VendorClaimWidget({
  claimed,
  vendorId,
  vendorContactEmail,
  vendorSlug,
  onClaimed,
}: Props) {
  const { data: session } = useSession();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error" | "claimed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const userEmail = session?.user?.email ?? null;
  const canClaimDirectly =
    !!userEmail && !!vendorContactEmail && emailMatches(userEmail, vendorContactEmail);

  useEffect(() => {
    if (search.get("claimed") === "1") {
      setMessage("Your listing is now claimed. The Claimed badge appears on your public page.");
      // ENG1.5 (2026-06-10) — the email round-trip resolved (the /confirm
      // endpoint granted the claim and redirected back with ?claimed=1).
      if (vendorSlug) trackVendorClaim("approved", "email", vendorSlug, vendorId);
      onClaimed?.();
      router.replace(pathname);
      return;
    }
    const err = search.get("claim_error");
    if (err) {
      setStatus("error");
      setMessage(ERROR_LABELS[err] ?? "Claim failed. Try again or contact support.");
      router.replace(pathname);
    }
  }, [search, router, pathname, onClaimed, vendorSlug, vendorId]);

  async function claimDirect() {
    if (!vendorSlug) {
      setStatus("error");
      setMessage("Missing vendor identifier — please reload the page.");
      return;
    }
    setStatus("sending");
    setMessage(null);
    // ENG1.5 (2026-06-10) — direct claim (email matched): method "register".
    if (vendorSlug) trackVendorClaim("started", "register", vendorSlug, vendorId);
    try {
      const res = await fetch("/api/vendor/claim/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: vendorSlug }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setStatus("error");
        setMessage(body.message ?? body.error ?? "Claim failed. Try again or contact support.");
        return;
      }
      // Direct claim is granted instantly — submitted + approved on success.
      if (vendorSlug) {
        trackVendorClaim("submitted", "register", vendorSlug, vendorId);
        trackVendorClaim("approved", "register", vendorSlug, vendorId);
      }
      setStatus("claimed");
      setMessage("Listing claimed. Reloading…");
      onClaimed?.();
      // Reload so the page re-fetches with claimed=true and the
      // updated session.roles.
      router.refresh();
    } catch (e) {
      setStatus("error");
      setMessage(`Network error: ${(e as Error).message}`);
    }
  }

  async function initiateEmailRoundTrip() {
    setStatus("sending");
    setMessage(null);
    // ENG1.5 (2026-06-10) — email round-trip path: method "email". The
    // approval leg fires later, when /confirm redirects back with ?claimed=1.
    if (vendorSlug) trackVendorClaim("started", "email", vendorSlug, vendorId);
    try {
      const res = await fetch("/api/vendor/claim/initiate", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setMessage(body.error ?? "Failed to start claim. Try again.");
        return;
      }
      if (vendorSlug) trackVendorClaim("submitted", "email", vendorSlug, vendorId);
      setStatus("sent");
      setMessage("Check your email for a confirmation link. It expires in 24 hours.");
    } catch (e) {
      setStatus("error");
      setMessage(`Network error: ${(e as Error).message}`);
    }
  }

  if (claimed) {
    return (
      <div className="mb-4 flex items-center gap-2">
        <Badge variant="success" className="gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Listing claimed
        </Badge>
        {message && <span className="text-sm text-stone-600">{message}</span>}
      </div>
    );
  }

  const buttonLabel =
    status === "sending"
      ? "Sending…"
      : status === "sent"
        ? "Email sent"
        : status === "claimed"
          ? "Claimed"
          : canClaimDirectly
            ? "Claim this listing now"
            : "Send me a confirmation email";

  return (
    <div className="mb-6 rounded-lg border border-amber/40 bg-amber/5 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-dark flex-shrink-0 mt-0.5" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-stone-900">Claim your listing</p>
          <p className="mt-1 text-sm text-stone-600">
            {canClaimDirectly
              ? "Your account email matches the contact email on this listing — we can confirm ownership in one click. The Claimed badge will appear on your public page."
              : "Confirming ownership unlocks the “Claimed” badge on your public page — event-goers see that the business itself maintains the listing."}
          </p>
          {message && (
            <p
              className={`mt-2 text-sm ${status === "error" ? "text-terracotta" : "text-sage-700"}`}
              role={status === "error" ? "alert" : "status"}
            >
              {message}
            </p>
          )}
          <div className="mt-3">
            <Button
              type="button"
              onClick={canClaimDirectly ? claimDirect : initiateEmailRoundTrip}
              disabled={status === "sending" || status === "sent" || status === "claimed"}
            >
              {buttonLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
