"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Plus,
  Pencil,
  Trash2,
  Eye,
  Store,
  RefreshCw,
  MapPin,
  GitMerge,
  Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, IconLink } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import {
  AdminPagedTable,
  type AdminColumn,
  type AdminFilter,
} from "@/components/admin/admin-paged-table";

interface Event {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  featured: boolean;
  venueName: string | null;
  promoterName: string | null;
  blogPostCount: number;
  // Pre-ingest gate trace. JSON array of short reason codes (e.g.
  // ["source_tier_3_aggregator", "start_equals_deadline"]) populated by
  // evaluateGates() when the row routed to PENDING_REVIEW. NULL = no gate
  // fired OR row predates the gates (pre-2026-05-16).
  gateFlags?: string | null;
  // Cohort 2 (2026-06-01) — set by the inbound-email workflow on
  // MEDIUM-confidence dedup hits, so the row can render an inline
  // "possible duplicate of X — merge into this" affordance.
  possibleDuplicate?: {
    id: string;
    name: string;
    slug: string;
    status: string;
    startDate: string | null;
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

const FILTERS: AdminFilter[] = [
  {
    param: "status",
    allLabel: "All Statuses",
    options: [
      { value: "APPROVED", label: "Approved" },
      { value: "TENTATIVE", label: "Tentative" },
      { value: "PENDING", label: "Pending" },
      { value: "DRAFT", label: "Draft" },
      { value: "REJECTED", label: "Rejected" },
      { value: "CANCELLED", label: "Cancelled" },
    ],
  },
  {
    param: "date",
    allLabel: "All Dates",
    options: [
      { value: "needs-date", label: "Needs date" },
      { value: "has-date", label: "Has date" },
    ],
  },
  {
    param: "venue",
    allLabel: "All Venues",
    options: [
      { value: "no-venue", label: "No Venue" },
      { value: "has-venue", label: "Has Venue" },
    ],
  },
  {
    param: "gate",
    allLabel: "All (gate flags)",
    title: "Filter by pre-ingest gate flags",
    options: [
      { value: "flagged", label: "Gate-flagged only" },
      { value: "clean", label: "Gate-clean only" },
    ],
  },
  {
    // Separate from "gate" — this targets flagged_for_review, the post-ingest
    // operator queue.
    param: "review",
    allLabel: "All (review flag)",
    title:
      "Filter by post-ingest operator review flag (set by helpers like the recurrence backfill)",
    options: [
      { value: "flagged", label: "Needs review" },
      { value: "clean", label: "Review-clean only" },
    ],
  },
];

export default function AdminEventsPage() {
  const [rescrapingId, setRescrapingId] = useState<string | null>(null);

  const handleDelete = async (id: string, name: string, reload: () => void) => {
    // Include the event name in the confirm so the operator can
    // re-confirm they targeted the right row (UX-R2, 2026-06-01 EVE).
    if (!confirm(`Delete event "${name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/admin/events/${id}`, { method: "DELETE" });
      if (res.ok) reload();
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
    candidate: { id: string; name: string },
    reload: () => void
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
      reload();
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

  const columns: AdminColumn<Event>[] = [
    {
      key: "name",
      label: "Event",
      sortKey: "name",
      cell: (event) => (
        <div>
          <p className="font-medium text-foreground">{event.name}</p>
          {event.featured && (
            <Badge variant="warning" className="mt-1">
              Featured
            </Badge>
          )}
          {event.gateFlags && event.gateFlags !== "[]" && (
            // Pre-ingest gate flagged this row — admin should verify against
            // the source before approving. The edit page shows the full list.
            <Badge variant="danger" className="mt-1 ml-1" title={event.gateFlags}>
              Flagged
            </Badge>
          )}
          {event.possibleDuplicate && (
            // Cohort 2 (2026-06-01) — MEDIUM-confidence dedup hit from the
            // inbound-email workflow. The merge button in Actions confirms it.
            <div className="mt-1 text-xs text-amber-700">
              Possible duplicate of:{" "}
              <Link
                href={`/events/${event.possibleDuplicate.slug}`}
                className="underline hover:text-amber-900"
                target="_blank"
              >
                {event.possibleDuplicate.name}
              </Link>{" "}
              <span className="text-muted-foreground">({event.possibleDuplicate.status})</span>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "venue",
      label: "Venue",
      sortKey: "venue",
      cell: (event) =>
        event.venueName ? (
          <span className="text-muted-foreground">{event.venueName}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-600">
            <MapPin className="w-3.5 h-3.5" />
            No venue
          </span>
        ),
    },
    {
      key: "promoter",
      label: "Promoter",
      sortKey: "promoter",
      cell: (event) => <span className="text-muted-foreground">{event.promoterName || "-"}</span>,
    },
    {
      key: "startDate",
      label: "Date",
      sortKey: "startDate",
      cell: (event) =>
        event.startDate ? (
          <span className="text-muted-foreground">{formatDate(event.startDate)}</span>
        ) : (
          <span className="text-amber-600">No date</span>
        ),
    },
    {
      key: "status",
      label: "Status",
      sortKey: "status",
      cell: (event) => <Badge variant={statusColors[event.status]}>{event.status}</Badge>,
    },
    {
      key: "blogPostCount",
      label: "Blog",
      sortKey: "blogPostCount",
      cell: (event) =>
        event.blogPostCount > 0 ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-light text-amber-bg-fg">
            {event.blogPostCount}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">0</span>
        ),
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      cell: (event, { reload }) => (
        <div className="flex items-center justify-end gap-1">
          {/* IconLink + IconButton primitives — type-enforced aria-label,
              ≥40px hit area, single interactive element (UX-R2, 2026-06-01). */}
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
              <RefreshCw className={rescrapingId === event.id ? "animate-spin text-royal" : ""} />
            }
          />
          {event.possibleDuplicate && (
            // Cohort 2 (2026-06-01) — only on PENDING rows the workflow flagged
            // as MEDIUM-confidence dedup hits.
            <IconButton
              onClick={() =>
                handleMerge(
                  event.id,
                  event.name,
                  { id: event.possibleDuplicate!.id, name: event.possibleDuplicate!.name },
                  reload
                )
              }
              aria-label={`Merge ${event.name} into ${event.possibleDuplicate.name}`}
              title={`Merge into "${event.possibleDuplicate.name}"`}
              icon={<GitMerge className="text-amber-700" />}
            />
          )}
          <IconButton
            variant="danger"
            onClick={() => handleDelete(event.id, event.name, reload)}
            aria-label={`Delete ${event.name}`}
            icon={<Trash2 />}
          />
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-foreground">Manage Events</h1>
        <div className="flex items-center gap-2">
          {/* F3 C2 — admin month calendar with click-to-add empty cells. */}
          <Link href="/admin/events/calendar">
            <Button variant="outline">
              <Calendar className="w-4 h-4 mr-2" />
              Calendar
            </Button>
          </Link>
          <Link href="/admin/events/new">
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Add Event
            </Button>
          </Link>
        </div>
      </div>
      <AdminPagedTable<Event>
        endpoint="/api/admin/events"
        columns={columns}
        rowKey={(e) => e.id}
        noun="event"
        searchPlaceholder="Search events by name…"
        filters={FILTERS}
        defaultSort={{ column: "startDate", direction: "asc" }}
      />
    </div>
  );
}
