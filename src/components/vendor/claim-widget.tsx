"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertCircle } from "lucide-react";

interface Props {
  claimed: boolean;
  onClaimed?: () => void;
}

const ERROR_LABELS: Record<string, string> = {
  missing_token: "Missing token in confirmation link.",
  not_found: "That confirmation link is no longer valid.",
  expired: "That confirmation link has expired. Request a new one.",
  wrong_account: "Please sign in with the account that requested the claim.",
  server: "Something went wrong on our side. Try again or contact support.",
};

/**
 * Vendor self-serve claim CTA + post-redirect status surface. Lives on
 * /vendor/profile. Renders one of three states:
 *  - claimed=false, no message → "Claim this listing" button
 *  - claimed=false, "check your email" toast after initiate
 *  - claimed=true → "Listing claimed" success badge
 * Also reads ?claimed=1 and ?claim_error=<reason> from the redirect target
 * and surfaces them, then strips the params from the URL.
 */
export function VendorClaimWidget({ claimed, onClaimed }: Props) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (search.get("claimed") === "1") {
      setMessage("Your listing is now claimed. The Claimed badge appears on your public page.");
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
  }, [search, router, pathname, onClaimed]);

  async function initiate() {
    setStatus("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/vendor/claim/initiate", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setMessage(body.error ?? "Failed to start claim. Try again.");
        return;
      }
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

  return (
    <div className="mb-6 rounded-lg border border-amber/40 bg-amber/5 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-dark flex-shrink-0 mt-0.5" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-stone-900">Claim your listing</p>
          <p className="mt-1 text-sm text-stone-600">
            Confirming ownership unlocks the &ldquo;Claimed&rdquo; badge on your public page —
            event-goers see that the business itself maintains the listing.
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
              onClick={initiate}
              disabled={status === "sending" || status === "sent"}
            >
              {status === "sending"
                ? "Sending…"
                : status === "sent"
                  ? "Email sent"
                  : "Claim this listing"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
