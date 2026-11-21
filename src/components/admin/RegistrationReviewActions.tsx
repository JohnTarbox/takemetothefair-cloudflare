"use client";

/**
 * OPE-1599 — resolve one row of the /admin/claims registration realness screen.
 *
 * Looks real records a decision. Suspend and Spam soft-delete the listing first
 * and record the decision only once that worked. No button emails anyone.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Decision = "LOOKS_REAL" | "SUSPENDED" | "SPAM";

async function failure(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
}

export function RegistrationReviewActions({ vendorId }: { vendorId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: Decision) => {
    setSubmitting(true);
    setError(null);
    try {
      if (decision !== "LOOKS_REAL") {
        const del = await fetch(`/api/admin/vendors/${encodeURIComponent(vendorId)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "soft" }),
        });
        if (!del.ok) throw new Error(await failure(del));
      }
      const res = await fetch("/api/admin/claims/registration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, decision }),
      });
      if (!res.ok) throw new Error(await failure(res));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={submitting}
        onClick={() => void decide("LOOKS_REAL")}
      >
        Looks real
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={submitting}
        onClick={() => void decide("SUSPENDED")}
      >
        Suspend listing
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={submitting}
        onClick={() => void decide("SPAM")}
      >
        Mark spam
      </Button>
      {error && <p className="w-full text-xs text-red-700">{error}</p>}
    </div>
  );
}
