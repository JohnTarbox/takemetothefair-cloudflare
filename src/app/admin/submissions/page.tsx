"use client";

import { useEffect, useState } from "react";
import { Check, X, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

export const runtime = "edge";

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startDate: string;
  endDate: string;
  createdAt: string;
  venue: { name: string; city: string; state: string };
  promoter: { companyName: string };
}

export default function AdminSubmissionsPage() {
  const [submissions, setSubmissions] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    fetchSubmissions();
  }, []);

  const fetchSubmissions = async () => {
    try {
      const res = await fetch("/api/admin/events?status=PENDING");
      const data = await res.json() as Event[];
      setSubmissions(data);
    } catch (error) {
      console.error("Failed to fetch submissions:", error);
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
        <div className="h-8 bg-gray-200 rounded w-1/4"></div>
        <div className="h-64 bg-gray-200 rounded"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Submission Queue</h1>
        <p className="mt-1 text-gray-600">
          Review and approve event submissions from promoters
        </p>
      </div>

      {submissions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-gray-500">No pending submissions</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {submissions.map((event) => (
            <Card key={event.id}>
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    {event.name}
                  </h2>
                  <p className="text-sm text-gray-500">
                    Submitted by {event.promoter.companyName} on{" "}
                    {formatDate(event.createdAt)}
                  </p>
                </div>
                <Badge variant="warning">Pending Review</Badge>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Venue</p>
                    <p className="text-gray-600">
                      {event.venue.name}, {event.venue.city}, {event.venue.state}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-700">Dates</p>
                    <p className="text-gray-600">
                      {formatDate(event.startDate)} - {formatDate(event.endDate)}
                    </p>
                  </div>
                </div>
                {event.description && (
                  <div className="mb-4">
                    <p className="text-sm font-medium text-gray-700">
                      Description
                    </p>
                    <p className="text-gray-600 line-clamp-3">
                      {event.description}
                    </p>
                  </div>
                )}
                <div className="flex items-center gap-3 pt-4 border-t border-gray-100">
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
                  <a
                    href={`/events/${event.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button variant="outline">
                      <Eye className="w-4 h-4 mr-2" />
                      Preview
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
