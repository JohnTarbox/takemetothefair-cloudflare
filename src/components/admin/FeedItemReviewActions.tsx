"use client";

/**
 * OPE-1630 item 3 — the four review actions for one organizer-feed item on
 * /admin/feed-review. POSTs to /api/admin/feed-items/[id]/review, the route the
 * MCP `review_feed_item` tool calls, so the rules (dedup, venue matching, the
 * approval gate, audit) are the tool's rules.
 *
 * The route's two refusals each have an explicit reviewer answer, and this
 * component offers it instead of a dead end:
 *   - venue_unmatched → the venue candidates, one click each, re-sent as venue_id;
 *   - duplicate / listed_by_another_organizer → "link to it", or "a different
 *     event, approve anyway", re-sent as not_duplicate_of (that one match only).
 * Nothing here guesses: every retry carries a choice the reviewer just made.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Mode = "idle" | "occurrence" | "link" | "reject";

interface Suggest {
  action: "link";
  event_id: string;
  event_name: string;
  event_slug: string;
}
interface VenueCandidate {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}
export interface ReviewResponse {
  ok?: boolean;
  code?: string;
  message?: string;
  error?: string;
  suggest?: Suggest;
  venue_candidates?: VenueCandidate[];
  errors?: string[];
  event?: { id: string; slug: string; name: string; status: string; series_id: string | null };
}

export interface ReviewBody {
  action: "approve" | "approve_as_occurrence" | "link" | "reject";
  event_id?: string;
  series_id?: string;
  venue_id?: string;
  not_duplicate_of?: string;
  note?: string;
}

/**
 * What the reviewer can do next after a refusal. Pure, exported for tests: the
 * retry carries the original body plus exactly one reviewer answer.
 */
export function refusalChoices(
  sent: ReviewBody,
  res: ReviewResponse
): { label: string; body: ReviewBody }[] {
  const out: { label: string; body: ReviewBody }[] = [];
  const approving = sent.action === "approve" || sent.action === "approve_as_occurrence";
  if (res.code === "venue_unmatched" && approving)
    for (const v of res.venue_candidates ?? [])
      out.push({
        label: `Use venue: ${v.name}${v.city ? `, ${v.city}` : ""}${v.state ? ` ${v.state}` : ""}`,
        body: { ...sent, venue_id: v.id },
      });
  if (
    (res.code === "duplicate" || res.code === "listed_by_another_organizer") &&
    res.suggest &&
    approving
  ) {
    out.push({
      label: `Link to "${res.suggest.event_name}"`,
      body: { action: "link", event_id: res.suggest.event_id, note: sent.note },
    });
    out.push({
      label: `Different event from "${res.suggest.event_name}": approve anyway`,
      body: { ...sent, not_duplicate_of: res.suggest.event_id },
    });
  }
  return out;
}

export function FeedItemReviewActions({
  feedItemId,
  closestEvent,
}: {
  feedItemId: string;
  closestEvent: { id: string; name: string } | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [field, setField] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<{ sent: ReviewBody; res: ReviewResponse } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reset = () => {
    setMode("idle");
    setField("");
    setRefusal(null);
  };

  const post = async (body: ReviewBody) => {
    setSubmitting(true);
    setRefusal(null);
    try {
      const res = await fetch(`/api/admin/feed-items/${encodeURIComponent(feedItemId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as ReviewResponse;
      if (!res.ok || data.ok === false) {
        setRefusal({
          sent: body,
          res: { ...data, message: data.message ?? data.error ?? `Request failed (${res.status})` },
        });
        return;
      }
      setDone(
        data.event
          ? `${body.action === "link" ? "Linked to" : "Created"} "${data.event.name}" (${data.event.status}${
              data.event.series_id ? `, series ${data.event.series_id}` : ""
            }).`
          : body.action === "reject"
            ? "Rejected."
            : "Done."
      );
      reset();
      router.refresh();
    } catch (e) {
      setRefusal({ sent: body, res: { message: e instanceof Error ? e.message : String(e) } });
    } finally {
      setSubmitting(false);
    }
  };

  const withNote = (b: ReviewBody): ReviewBody => (note.trim() ? { ...b, note: note.trim() } : b);

  if (done) return <p className="text-sm text-sage-700">{done}</p>;

  return (
    <div className="space-y-2" data-testid="feed-review-actions">
      {mode === "idle" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={submitting}
            onClick={() => post(withNote({ action: "approve" }))}
          >
            {submitting ? "Working…" : "Approve"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => {
              setRefusal(null);
              setMode("occurrence");
            }}
          >
            Occurrence…
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => {
              setRefusal(null);
              setField(closestEvent?.id ?? "");
              setMode("link");
            }}
          >
            Link…
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={submitting}
            onClick={() => {
              setRefusal(null);
              setMode("reject");
            }}
          >
            Reject…
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {mode !== "reject" ? (
            <input
              value={field}
              onChange={(e) => setField(e.target.value)}
              placeholder={mode === "occurrence" ? "Series id" : "Event id"}
              aria-label={mode === "occurrence" ? "Series id" : "Event id"}
              className="w-full border border-border rounded px-2 py-1 text-sm font-mono"
              disabled={submitting}
            />
          ) : null}
          {mode === "link" && closestEvent && field === closestEvent.id ? (
            <p className="text-xs text-muted-foreground">Prefilled: {closestEvent.name}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === "reject" ? "danger" : "primary"}
              size="sm"
              disabled={
                submitting ||
                (mode === "reject" ? note.trim().length === 0 : field.trim().length === 0)
              }
              onClick={() =>
                post(
                  withNote(
                    mode === "occurrence"
                      ? { action: "approve_as_occurrence", series_id: field.trim() }
                      : mode === "link"
                        ? { action: "link", event_id: field.trim() }
                        : { action: "reject" }
                  )
                )
              }
            >
              {submitting
                ? "Working…"
                : mode === "occurrence"
                  ? "Approve as occurrence"
                  : mode === "link"
                    ? "Confirm link"
                    : "Confirm reject"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={1}
        maxLength={1000}
        placeholder={
          mode === "reject" ? 'Reason (required), e.g. "private event"' : "Note (optional)"
        }
        aria-label="Review note"
        className="w-full border border-border rounded px-2 py-1 text-sm"
        disabled={submitting}
      />
      {refusal ? (
        <div className="space-y-1" role="alert">
          <p className="text-sm text-red-600 break-words">{refusal.res.message}</p>
          {refusal.res.errors?.length ? (
            <ul className="text-xs text-red-600 list-disc pl-4">
              {refusal.res.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-col gap-1">
            {refusalChoices(refusal.sent, refusal.res).map((c) => (
              <Button
                key={c.label}
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting}
                className="justify-start text-left"
                onClick={() => post(c.body)}
              >
                {c.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
