"use client";

/**
 * OPE-65 — approve / reject affordance for a single row in the /admin/claims
 * review queue. Approve is one click; Reject opens an inline required-reason
 * input. POSTs to /api/admin/claims and refreshes the server-rendered page on
 * success. Surfaces the API's `reason` inline on failure (e.g. the
 * `already_claimed_by_other` dispute case).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface ClaimReviewActionsProps {
  claimId: string;
}

const REASON_MESSAGES: Record<string, string> = {
  already_claimed_by_other:
    "This listing is already claimed by a different user — resolve the dispute manually before approving.",
  not_reviewable: "This claim has already been decided.",
  not_found: "This claim no longer exists.",
  entity_missing: "The listing this claim points to no longer exists.",
  unsupported_entity: "This entity type can't be claimed here.",
};

export function ClaimReviewActions({ claimId }: ClaimReviewActionsProps) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (body: { action: "approve" | "reject"; reason?: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const key = data.error ?? "";
        throw new Error(REASON_MESSAGES[key] ?? data.error ?? `Request failed (${res.status})`);
      }
      setRejecting(false);
      setReason("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      {!rejecting ? (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="primary"
            disabled={submitting}
            onClick={() => post({ action: "approve" })}
          >
            {submitting ? "Working…" : "Approve"}
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={submitting}
            onClick={() => {
              setError(null);
              setRejecting(true);
            }}
          >
            Reject
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Reason for rejection (required — sent to the claimant)"
            className="w-full border border-border rounded px-2 py-1 text-sm"
            disabled={submitting}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="danger"
              disabled={submitting || reason.trim().length === 0}
              onClick={() => post({ action: "reject", reason: reason.trim() })}
            >
              {submitting ? "Working…" : "Confirm reject"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setRejecting(false);
                setReason("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-red-600 break-words">{error}</p>}
    </div>
  );
}
