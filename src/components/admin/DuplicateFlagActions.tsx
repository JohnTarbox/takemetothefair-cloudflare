"use client";

/**
 * OPE-1117 — the three verdicts on one flagged pair in /admin/duplicates/flags.
 *
 *   Not a duplicate  → records a dismissal for THIS pair; the flag stays on the
 *                      row as history, the row leaves the queue.
 *   Reject as dup    → REJECTED + the OPE-450 adjudication naming the keeper.
 *   Merge into keeper → the existing /api/admin/duplicates/merge (slug 301,
 *                      FK transfer, audit). Offered last because it is the only
 *                      irreversible one.
 *
 * Every action needs a human click; the detector's base rate is 40%, so the
 * queue is a candidate list, never a to-merge list.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface DuplicateFlagActionsProps {
  eventId: string;
  candidateId: string;
  eventName: string;
  candidateName: string;
}

const REASON_MESSAGES: Record<string, string> = {
  not_found: "This event no longer exists.",
  not_flagged: "This event is no longer flagged.",
  candidate_mismatch:
    "The flag now points at a different event than the one shown — reload before deciding.",
  already_resolved: "Someone has already resolved this flag — reload the queue.",
};

type Mode = "idle" | "dismiss" | "confirm-merge";

export function DuplicateFlagActions({
  eventId,
  candidateId,
  eventName,
  candidateName,
}: DuplicateFlagActionsProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (request: () => Promise<Response>) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await request();
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        success?: boolean;
      };
      if (!res.ok || data.success === false) {
        const key = data.error ?? "";
        throw new Error(
          REASON_MESSAGES[key] ?? data.message ?? data.error ?? `Request failed (${res.status})`
        );
      }
      setMode("idle");
      setNote("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const verdict = (action: "dismiss" | "reject", noteText?: string) =>
    run(() =>
      fetch("/api/admin/duplicates/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, candidateId, action, note: noteText }),
      })
    );

  const merge = () =>
    run(() =>
      fetch("/api/admin/duplicates/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "events", primaryId: candidateId, duplicateId: eventId }),
      })
    );

  return (
    <div className="space-y-2">
      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => {
              setError(null);
              setMode("dismiss");
            }}
          >
            Not a duplicate
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={submitting}
            onClick={() => verdict("reject")}
          >
            {submitting ? "Working…" : "Reject as duplicate"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => {
              setError(null);
              setMode("confirm-merge");
            }}
          >
            Merge into keeper…
          </Button>
        </div>
      )}

      {mode === "dismiss" && (
        <div className="space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Why they are different (optional) — e.g. same fairground, different organizer"
            className="w-full border border-border rounded px-2 py-1 text-sm"
            disabled={submitting}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="primary"
              disabled={submitting}
              onClick={() => verdict("dismiss", note.trim() || undefined)}
            >
              {submitting ? "Working…" : "Confirm: two different events"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => setMode("idle")}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "confirm-merge" && (
        <div className="space-y-2">
          <p className="text-sm text-foreground">
            Merge <strong>{eventName}</strong> into <strong>{candidateName}</strong>? Its slug will
            301 to the keeper and its vendors, days and favorites move across. This cannot be undone
            from here.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="danger" disabled={submitting} onClick={merge}>
              {submitting ? "Merging…" : "Confirm merge"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => setMode("idle")}
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
