"use client";

import { useEffect, useState } from "react";
import { Check, X, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDateRange } from "@/lib/utils";

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  venue: { name: string; city: string; state: string } | null;
  promoter: { companyName: string } | null;
  submitter: { name: string | null; email: string } | null;
  suggesterEmail: string | null;
  sourceName: string | null;
}

export default function AdminSubmissionsPage() {
  const [submissions, setSubmissions] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    fetchSubmissions();
  }, []);

  const fetchSubmissions = async () => {
    try {
      const res = await fetch("/api/admin/events?status=PENDING");
      const data: unknown = await res.json();

      // The endpoint returns an Event[] on success but an `{ error }` envelope
      // on failure. Guard the shape: a non-OK status or a non-array body must
      // degrade to a clean message, never reach the unconditional `.map` below —
      // that throws `TypeError: e.map is not a function` and unwinds to the
      // global error boundary (white-screen). See OPE-24.
      //
      // Surface the REAL failure honestly: only a 401/403 is an auth problem.
      // A 500 (e.g. the D1 "too many columns" outage in OPE-26) must NOT be
      // mislabeled as "session expired" — that copy sent debugging down the
      // wrong path. Log the actual status + server message so the failure is
      // visible in the console even when the UI shows a friendly card.
      if (!res.ok || !Array.isArray(data)) {
        const serverMessage =
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : null;
        console.error(
          `Failed to fetch submissions: ${res.status} ${res.statusText}`,
          serverMessage ?? data
        );
        if (res.status === 401 || res.status === 403) {
          setError("Your admin session has expired. Please sign in again.");
        } else {
          setError(serverMessage ?? `Couldn't load submissions (server error ${res.status}).`);
        }
        setSubmissions([]);
        return;
      }

      setError(null);
      setSubmissions(data as Event[]);
    } catch (error) {
      console.error("Failed to fetch submissions:", error);
      setError("Couldn't load submissions — the server may be unavailable.");
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (id: string, action: "approve" | "reject") => {
    setProcessing(id);
    try {
      const res = await fetch(`/api/admin/events/${id}/${action}`, {
        method: "POST",
      });
      if (res.ok) {
        setSubmissions(submissions.filter((s) => s.id !== id));
      }
    } catch (error) {
      console.error(`Failed to ${action} submission:`, error);
    } finally {
      setProcessing(null);
    }
  };

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
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Submission Queue</h1>
        <p className="mt-1 text-muted-foreground">
          Review and approve event submissions from promoters
        </p>
      </div>

      {error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{error}</p>
            <Button type="button" variant="outline" className="mt-4" onClick={fetchSubmissions}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : submissions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No pending submissions</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {submissions.map((event) => (
            <Card key={event.id}>
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{event.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    Submitted by{" "}
                    {event.submitter?.name ||
                      event.submitter?.email ||
                      event.suggesterEmail ||
                      event.sourceName ||
                      event.promoter?.companyName ||
                      "Unknown"}{" "}
                    on {formatDate(event.createdAt)}
                  </p>
                </div>
                <Badge variant="warning">Pending Review</Badge>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <div>
                    <p className="text-sm font-medium text-foreground">Venue</p>
                    <p className="text-muted-foreground">
                      {event.venue
                        ? `${event.venue.name}, ${event.venue.city}, ${event.venue.state}`
                        : "No venue assigned"}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Dates</p>
                    <p className="text-muted-foreground">
                      {formatDateRange(event.startDate, event.endDate)}
                    </p>
                  </div>
                </div>
                {event.description && (
                  <div className="mb-4">
                    <p className="text-sm font-medium text-foreground">Description</p>
                    <p className="text-muted-foreground line-clamp-3">{event.description}</p>
                  </div>
                )}
                <div className="flex items-center gap-3 pt-4 border-t border-border">
                  <Button
                    onClick={() => handleAction(event.id, "approve")}
                    disabled={processing === event.id}
                    isLoading={processing === event.id}
                  >
                    <Check className="w-4 h-4 mr-2" />
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => handleAction(event.id, "reject")}
                    disabled={processing === event.id}
                  >
                    <X className="w-4 h-4 mr-2" />
                    Reject
                  </Button>
                  <a href={`/admin/events/${event.id}/edit`}>
                    <Button variant="outline">
                      <Eye className="w-4 h-4 mr-2" />
                      Review
                    </Button>
                  </a>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
