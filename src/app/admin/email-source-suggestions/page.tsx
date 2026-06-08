"use client";

/**
 * Admin review page for source-suggestion emails. Lists pending
 * email_source_suggestions rows (sender suggested a website as an
 * events source via inbound email, Tier 3 path inserted the row) and
 * lets the admin approve / reject each.
 *
 * Counterpart to the API at /api/admin/email-source-suggestions
 * (which the source_suggestion handler in mcp-server writes into and
 * this page reads/mutates via).
 *
 * Filter switch toggles between pending_review (default), active, and
 * rejected, so admin can audit prior decisions without writing SQL.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "@/lib/datetime";

export const runtime = "edge";

interface SuggestionRow {
  id: string;
  url: string;
  host: string;
  status: string;
  suggestedByEmail: string | null;
  suggestedViaInboundId: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  adminNotes: string | null;
  createdAt: string;
}

type StatusFilter = "pending_review" | "active" | "rejected";

export default function EmailSourceSuggestionsPage() {
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending_review");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/email-source-suggestions?status=${encodeURIComponent(statusFilter)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { rows: SuggestionRow[] };
      setRows(data.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  async function act(id: string, action: "approve" | "reject") {
    setActing(id);
    setError(null);
    try {
      const notes = window.prompt(`Optional notes for this ${action}:`, "");
      // Cancel pressed → null → bail without acting (don't accidentally
      // act on a Cancel as if it were an empty-notes confirm).
      if (notes === null) {
        setActing(null);
        return;
      }
      const res = await fetch("/api/admin/email-source-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, notes: notes || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetchRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Email source suggestions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Domains a sender suggested via inbound email as a potential events source. Approve to add
          to the active set (Tier 1 of the source_suggestion handler short-circuits future
          mentions); reject to leave the row for audit.
        </p>
      </header>

      <div className="flex gap-2 text-sm">
        {(["pending_review", "active", "rejected"] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={
              statusFilter === s
                ? "rounded bg-secondary px-3 py-1 text-secondary-foreground"
                : "rounded bg-muted px-3 py-1 text-foreground hover:bg-muted"
            }
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">
          No suggestions in the {statusFilter.replace("_", " ")} bucket.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <h2 className="font-mono text-base">{row.host}</h2>
                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(row.createdAt)}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">URL</dt>
                    <dd>
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-royal hover:underline"
                      >
                        {row.url}
                      </a>
                    </dd>
                    {row.suggestedByEmail && (
                      <>
                        <dt className="text-muted-foreground">Suggested by</dt>
                        <dd className="font-mono text-xs">{row.suggestedByEmail}</dd>
                      </>
                    )}
                    {row.adminNotes && (
                      <>
                        <dt className="text-muted-foreground">Notes</dt>
                        <dd>{row.adminNotes}</dd>
                      </>
                    )}
                    {row.reviewedAt && (
                      <>
                        <dt className="text-muted-foreground">Reviewed</dt>
                        <dd>
                          {formatTimestamp(row.reviewedAt)}
                          {row.reviewedByUserId ? ` by ${row.reviewedByUserId.slice(0, 8)}` : ""}
                        </dd>
                      </>
                    )}
                  </dl>

                  {statusFilter === "pending_review" && (
                    <div className="mt-4 flex gap-2">
                      <Button
                        type="button"
                        onClick={() => act(row.id, "approve")}
                        disabled={acting === row.id}
                      >
                        {acting === row.id ? "…" : "Approve"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => act(row.id, "reject")}
                        disabled={acting === row.id}
                      >
                        {acting === row.id ? "…" : "Reject"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
