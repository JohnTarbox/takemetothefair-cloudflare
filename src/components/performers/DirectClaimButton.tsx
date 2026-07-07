"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface Props {
  performerSlug: string;
}

/**
 * OPE-116 — one-click claim button for performer pages, shown when the signed-in
 * visitor's verified email matches the act's contact_email. POSTs
 * /api/performer/claim/direct and refreshes so the parent page re-renders with
 * claimed=true (CTA disappears, Claimed badge appears). Eligibility is computed
 * server-side before this renders; the error branch is defensive (race).
 */
export function DirectClaimButton({ performerSlug }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setStatus("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/performer/claim/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: performerSlug }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setStatus("error");
        setMessage(body.message ?? body.error ?? "Claim failed. Try again or contact support.");
        return;
      }
      router.refresh();
    } catch (e) {
      setStatus("error");
      setMessage(`Network error: ${(e as Error).message}`);
    }
  }

  return (
    <div className="mt-3 inline-flex flex-col gap-2">
      <Button size="sm" onClick={handleClick} disabled={status === "sending"}>
        {status === "sending" ? "Claiming…" : "Claim this free profile now"}
      </Button>
      {message && (
        <p className="text-sm text-terracotta max-w-md" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
