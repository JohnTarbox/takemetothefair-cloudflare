"use client";

/**
 * Inline outreach-log affordance for /admin/vendor-claim-leaderboard
 * (analyst J1, 2026-05-29 PM). Pops a small form with channel +
 * outcome + notes, POSTs to /api/admin/vendors/[id]/outreach.
 *
 * Pattern mirrors the Salvage button on /admin/inbound-emails: minimal
 * inline modal, optimistic-ish UI (refresh on success), per-button
 * loading + error state local to the component. The page is server-
 * rendered so a successful log reloads via router.refresh().
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

type Channel = "email" | "phone" | "in_person" | "other";
type Outcome = "sent" | "opened" | "replied" | "claimed" | "rejected" | "no_response" | "bounced";

interface LogOutreachButtonProps {
  vendorId: string;
}

export function LogOutreachButton({ vendorId }: LogOutreachButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>("email");
  const [outcome, setOutcome] = useState<Outcome | "">("sent");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
      >
        Log
      </button>
    );
  }

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/vendors/${vendorId}/outreach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          outcome: outcome === "" ? undefined : outcome,
          notes: notes.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setOpen(false);
      // Reset form so re-opening doesn't carry stale state.
      setNotes("");
      setOutcome("sent");
      // Server-rendered page — refresh to pick up the new outreach row.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="text-left bg-white border border-gray-300 rounded p-2 text-xs space-y-1.5 shadow-sm w-56">
      <div className="flex items-center justify-between">
        <span className="font-medium text-gray-700">Log outreach</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-gray-600 hover:text-gray-600"
          aria-label="Cancel"
        >
          ×
        </button>
      </div>
      <div>
        <label className="block text-gray-500">Channel</label>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          className="w-full border border-gray-200 rounded px-1 py-0.5"
          disabled={submitting}
        >
          <option value="email">email</option>
          <option value="phone">phone</option>
          <option value="in_person">in person</option>
          <option value="other">other</option>
        </select>
      </div>
      <div>
        <label className="block text-gray-500">Outcome</label>
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as Outcome | "")}
          className="w-full border border-gray-200 rounded px-1 py-0.5"
          disabled={submitting}
        >
          <option value="">(in flight, no outcome yet)</option>
          <option value="sent">sent</option>
          <option value="opened">opened</option>
          <option value="replied">replied</option>
          <option value="claimed">claimed</option>
          <option value="rejected">rejected</option>
          <option value="no_response">no response</option>
          <option value="bounced">bounced</option>
        </select>
      </div>
      <div>
        <label className="block text-gray-500">Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={500}
          className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs"
          disabled={submitting}
        />
      </div>
      {error && <p className="text-red-600 text-[10px] break-words">{error}</p>}
      <div className="flex justify-end gap-1 pt-1">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-2 py-0.5 border border-gray-200 rounded text-gray-600 hover:bg-gray-50"
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          disabled={submitting}
        >
          {submitting ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
