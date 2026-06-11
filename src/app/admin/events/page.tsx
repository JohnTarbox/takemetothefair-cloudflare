"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, Store, RefreshCw, MapPin, GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, IconLink } from "@/components/ui/icon-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { pluralize } from "@/lib/text";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";

interface Event {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: string;
  endDate: string;
  featured: boolean;
  venue: { name: string } | null;
  promoter: { companyName: string } | null;
  blogPostCount: number;
  // Pre-ingest gate trace. JSON array of short reason codes (e.g.
  // ["source_tier_3_aggregator", "start_equals_deadline"]) populated by
  // evaluateGates() when the row routed to PENDING_REVIEW. NULL = no gate
  // fired OR row predates the gates (pre-2026-05-16).
  gateFlags?: string | null;
  // UX-R1 / C1 (2026-06-01 EVE). Post-ingest operator-review marker. Set
  // by scripts/backfill-event-days-from-description.ts (and any future
  // helper) when the row needs manual triage. Distinct from gateFlags
  // (pre-ingest gate decision); filter via the "Review flag" select.
  flaggedForReview?: number;
  // Cohort 2 (2026-06-01) — set by the inbound-email workflow on
  // MEDIUM-confidence dedup hits. /api/admin/events GET attaches the
  // candidate event's metadata so the row can render an inline
  // "possible duplicate of X — merge into this" affordance.
  possibleDuplicate?: {
    id: string;
    name: string;
    slug: string;
    status: string;
    startDate: string | Date | null;
  } | null;
}

const statusColors: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "default",
  PENDING: "warning",
  TENTATIVE: "info",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "default",
};

export default function AdminEventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "startDate",
    direction: "asc",
  });
  const [rescrapingId, setRescrapingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [venueFilter, setVenueFilter] = useState<string>("all");
  const [flagFilter, setFlagFilter] = useState<string>("all");
  // Separate from flagFilter (which targets gateFlags) — reviewFlagFilter
  // targets flagged_for_review, the post-ingest operator queue.
  const [reviewFlagFilter, setReviewFlagFilter] = useState<string>("all");

  useEffect(() => {
    fetchEvents();
  }, []);

  const fetchEvents = async () => {
    try {
      const res = await fetch("/api/admin/events");
      const data = (await res.json()) as Event[];
      setEvents(data);
    } catch (error) {
      console.error("Failed to fetch events:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    // Include the event name in the confirm so the operator can
    // re-confirm they targeted the right row (UX-R2, 2026-06-01 EVE).
    if (!confirm(`Delete event "${name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/admin/events/${id}`, { method: "DELETE" });
      if (res.ok) {
        setEvents(events.filter((e) => e.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete event:", error);
    }
  };

  // Cohort 2 (2026-06-01) — merge this row INTO its possibleDuplicate
  // candidate. Keeper = the existing public event the workflow flagged
  // as a potential match; duplicate = this PENDING row from the
  // inbound-email submission. Same /api/admin/duplicates/merge endpoint
  // the /admin/duplicates UI uses (see src/app/admin/duplicates/page.tsx).
  const handleMerge = async (
    pendingEventId: string,
    pendingEventName: string,
    candidate: { id: string; name: string }
  ) => {
    const ok = confirm(
      `Merge "${pendingEventName}" INTO "${candidate.name}"?\n\nThis tombstones the PENDING row, redirects its slug to the candidate, and transfers any vendors/days/citations/links. This cannot be undone.`
    );
    if (!ok) return;
    try {
      const res = await fetch("/api/admin/duplicates/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "events",
          primaryId: candidate.id,
          duplicateId: pendingEventId,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !data?.success) {
        alert(`Merge failed: ${data?.error ?? `HTTP ${res.status}`}`);
        return;
      }
      // Refresh the list so the tombstoned row disappears.
      fetchEvents();
    } catch (error) {
      console.error("Failed to merge:", error);
      alert("Merge failed. Check console for details.");
    }
  };

  const handleRescrape = async (id: string) => {
    setRescrapingId(id);
    try {
      const res = await fetch("/api/admin/import/rescrape-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_ids: [id] }),
      });
      const data = (await res.json()) as {
        details?: { status: string; fieldsUpdated?: string[] }[];
      };
      const detail = data.details?.[0];
      if (detail?.status === "updated") {
        alert(`Updated: ${detail.fieldsUpdated?.join(", ")}`);
      } else if (detail?.status === "skipped") {
        alert("No changes found — data is already up to date.");
      } else if (detail?.status === "no_scraper") {
        alert("No scraper available for this event's source.");
      } else if (detail?.status === "no_source") {
        alert("This event has no source URL to re-scrape.");
      } else {
        alert(`Re-scrape result: ${detail?.status || "unknown"}`);
      }
    } catch (error) {
      console.error("Failed to re-scrape:", error);
      alert("Re-scrape failed. Check console for details.");
    } finally {
      setRescrapingId(null);
    }
  };

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const filteredEvents = events.filter((e) => {
    if (statusFilter !== "all" && e.status !== statusFilter) return false;
    if (venueFilter === "no-venue" && e.venue !== null) return false;
    if (venueFilter === "has-venue" && e.venue === null) return false;
    // Gate-flag filter (PR #?, analyst spec 2026-05-16): "flagged" surfaces
    // rows held by evaluateGates(); "clean" surfaces rows that passed. The
    // gateFlags column is JSON-string; treat any non-null/empty value as
    // flagged regardless of the actual reasons.
    const isFlagged = e.gateFlags != null && e.gateFlags !== "" && e.gateFlags !== "[]";
    if (flagFilter === "flagged" && !isFlagged) return false;
    if (flagFilter === "clean" && isFlagged) return false;
    // UX-R1 / C1: post-ingest review queue. Treat any truthy value as
    // flagged (column is INTEGER 0/1 but JSON may surface as number or
    // boolean depending on serialization).
    const isReviewFlagged = Boolean(e.flaggedForReview);
    if (reviewFlagFilter === "flagged" && !isReviewFlagged) return false;
    if (reviewFlagFilter === "clean" && isReviewFlagged) return false;
    return true;
  });

  const sortedEvents = sortData(filteredEvents, sortConfig, {
    name: (e) => e.name.toLowerCase(),
    venue: (e) => e.venue?.name?.toLowerCase() || "",
    promoter: (e) => e.promoter?.companyName?.toLowerCase() || "",
    startDate: (e) => new Date(e.startDate).getTime(),
    status: (e) => e.status,
    blogPostCount: (e) => e.blogPostCount ?? 0,
  });

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-muted rounded w-1/4"></div>
        <div className="h-64 bg-muted rounded"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-foreground">Manage Events</h1>
        <Link href="/admin/events/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Event
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground bg-card"
        >
          <option value="all">All Statuses</option>
          <option value="APPROVED">Approved</option>
          <option value="TENTATIVE">Tentative</option>
          <option value="PENDING">Pending</option>
          <option value="DRAFT">Draft</option>
          <option value="REJECTED">Rejected</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select
          value={venueFilter}
          onChange={(e) => setVenueFilter(e.target.value)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground bg-card"
        >
          <option value="all">All Venues</option>
          <option value="no-venue">No Venue</option>
          <option value="has-venue">Has Venue</option>
        </select>
        <select
          value={flagFilter}
          onChange={(e) => setFlagFilter(e.target.value)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground bg-card"
          title="Filter by pre-ingest gate flags"
        >
          <option value="all">All (gate flags)</option>
          <option value="flagged">Gate-flagged only</option>
          <option value="clean">Gate-clean only</option>
        </select>
        <select
          value={reviewFlagFilter}
          onChange={(e) => setReviewFlagFilter(e.target.value)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground bg-card"
          title="Filter by post-ingest operator review flag (set by helpers like the recurrence backfill)"
        >
          <option value="all">All (review flag)</option>
          <option value="flagged">Needs review</option>
          <option value="clean">Review-clean only</option>
        </select>
        {(statusFilter !== "all" ||
          venueFilter !== "all" ||
          flagFilter !== "all" ||
          reviewFlagFilter !== "all") && (
          <button
            onClick={() => {
              setStatusFilter("all");
              setVenueFilter("all");
              setFlagFilter("all");
              setReviewFlagFilter("all");
            }}
            className="text-sm text-royal hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <Card>
        <CardHeader>
          <p className="text-sm text-muted-foreground">
            {filteredEvents.length === events.length
              ? `${pluralize(events.length, "event")} total`
              : `${filteredEvents.length} of ${pluralize(events.length, "event")}`}
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <SortableHeader
                    column="name"
                    label="Event"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="venue"
                    label="Venue"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="promoter"
                    label="Promoter"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="startDate"
                    label="Date"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="status"
                    label="Status"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="blogPostCount"
                    label="Blog"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedEvents.map((event) => (
                  <tr key={event.id} className="border-b border-border">
                    <td className="py-3 px-4">
                      <div>
                        <p className="font-medium text-foreground">{event.name}</p>
                        {event.featured && (
                          <Badge variant="warning" className="mt-1">
                            Featured
                          </Badge>
                        )}
                        {event.gateFlags && event.gateFlags !== "[]" && (
                          // Pre-ingest gate flagged this row — admin should
                          // verify against the source before approving. The
                          // edit page shows the full reason list.
                          <Badge variant="danger" className="mt-1 ml-1" title={event.gateFlags}>
                            Flagged
                          </Badge>
                        )}
                        {event.possibleDuplicate && (
                          // Cohort 2 (2026-06-01) — MEDIUM-confidence dedup
                          // hit from the inbound-email workflow. The merge
                          // button in the Actions column lets the operator
                          // confirm with one click (or ignore and approve
                          // separately if they're genuinely distinct).
                          <div className="mt-1 text-xs text-amber-700">
                            Possible duplicate of:{" "}
                            <Link
                              href={`/events/${event.possibleDuplicate.slug}`}
                              className="underline hover:text-amber-900"
                              target="_blank"
                            >
                              {event.possibleDuplicate.name}
                            </Link>{" "}
                            <span className="text-muted-foreground">
                              ({event.possibleDuplicate.status})
                            </span>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {event.venue?.name ? (
                        <span className="text-muted-foreground">{event.venue.name}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-600">
                          <MapPin className="w-3.5 h-3.5" />
                          No venue
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {event.promoter?.companyName || "-"}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {formatDate(event.startDate)}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={statusColors[event.status]}>{event.status}</Badge>
                    </td>
                    <td className="py-3 px-4">
                      {event.blogPostCount > 0 ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-light text-amber-bg-fg">
                          {event.blogPostCount}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        {/* IconLink + IconButton primitives — type-enforced
                            aria-label, ≥40px hit area, single interactive
                            element (no nested Link>Button). UX-R2, 2026-06-01. */}
                        <IconLink
                          href={`/events/${event.slug}`}
                          aria-label={`View ${event.name}`}
                          icon={<Eye />}
                        />
                        <IconLink
                          href={`/admin/events/${event.id}/vendors`}
                          aria-label={`Manage vendors for ${event.name}`}
                          icon={<Store />}
                        />
                        <IconLink
                          href={`/admin/events/${event.id}/edit`}
                          aria-label={`Edit ${event.name}`}
                          icon={<Pencil />}
                        />
                        <IconButton
                          onClick={() => handleRescrape(event.id)}
                          disabled={rescrapingId === event.id}
                          aria-label={`Re-scrape ${event.name}`}
                          icon={
                            <RefreshCw
                              className={rescrapingId === event.id ? "animate-spin text-royal" : ""}
                            />
                          }
                        />
                        {event.possibleDuplicate && (
                          // Cohort 2 (2026-06-01) — only renders on PENDING
                          // rows that the workflow flagged as MEDIUM-
                          // confidence dedup hits. Operator confirms the
                          // merge here in one click.
                          <IconButton
                            onClick={() =>
                              handleMerge(event.id, event.name, {
                                id: event.possibleDuplicate!.id,
                                name: event.possibleDuplicate!.name,
                              })
                            }
                            aria-label={`Merge ${event.name} into ${event.possibleDuplicate.name}`}
                            title={`Merge into "${event.possibleDuplicate.name}"`}
                            icon={<GitMerge className="text-amber-700" />}
                          />
                        )}
                        <IconButton
                          variant="danger"
                          onClick={() => handleDelete(event.id, event.name)}
                          aria-label={`Delete ${event.name}`}
                          icon={<Trash2 />}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
