"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface Props {
  vendorSlug: string;
}

/**
 * One-click claim button for vendor pages, used when the signed-in
 * visitor's verified email matches the vendor's contact_email.
 * POSTs /api/vendor/claim/direct and refreshes the page on success,
 * which causes the parent page to re-render with claimed=true (so
 * the Claim CTA disappears and the Claimed badge appears).
 *
 * Eligibility is computed server-side in vendors/[slug]/page.tsx
 * before this button is rendered — so by the time the user clicks,
 * the API call should succeed. The error branch is defensive
 * (race: profile edited between page render and click).
 */
export function DirectClaimButton({ vendorSlug }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setStatus("sending");
    setMessage(null);
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
      // Force a refresh so the page re-fetches the vendor with
      // claimed=true and the session.roles array picks up the new
      // VENDOR grant.
      router.refresh();
    } catch (e) {
      setStatus("error");
      setMessage(`Network error: ${(e as Error).message}`);
    }
  }

  return (
    <div className="mt-3 inline-flex flex-col gap-2">
      <Button size="sm" onClick={handleClick} disabled={status === "sending"}>
        {status === "sending" ? "Claiming…" : "Claim this free listing now"}
      </Button>
      {message && (
        <p className="text-sm text-terracotta max-w-md" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
