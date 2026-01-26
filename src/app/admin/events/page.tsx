"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";

export const runtime = "edge";

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
}

const statusColors: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "default",
  PENDING: "warning",
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

  useEffect(() => {
    fetchEvents();
  }, []);

  const fetchEvents = async () => {
    try {
      const res = await fetch("/api/admin/events");
      const data = await res.json() as Event[];
      setEvents(data);
    } catch (error) {
      console.error("Failed to fetch events:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this event?")) return;

    try {
      const res = await fetch(`/api/admin/events/${id}`, { method: "DELETE" });
      if (res.ok) {
        setEvents(events.filter((e) => e.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete event:", error);
    }
  };

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const sortedEvents = sortData(events, sortConfig, {
    name: (e) => e.name.toLowerCase(),
    venue: (e) => e.venue?.name?.toLowerCase() || "",
    promoter: (e) => e.promoter?.companyName?.toLowerCase() || "",
    startDate: (e) => new Date(e.startDate).getTime(),
    status: (e) => e.status,
  });

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
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Manage Events</h1>
        <Link href="/admin/events/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Event
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <p className="text-sm text-gray-600">{events.length} events total</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
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
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedEvents.map((event) => (
                  <tr key={event.id} className="border-b border-gray-100">
                    <td className="py-3 px-4">
                      <div>
                        <p className="font-medium text-gray-900">{event.name}</p>
                        {event.featured && (
                          <Badge variant="warning" className="mt-1">
                            Featured
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {event.venue?.name || "-"}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {event.promoter?.companyName || "-"}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {formatDate(event.startDate)}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={statusColors[event.status]}>
                        {event.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/events/${event.slug}`}>
                          <Button variant="ghost" size="sm" aria-label={`View ${event.name}`}>
                            <Eye className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Link href={`/admin/events/${event.id}/vendors`}>
                          <Button variant="ghost" size="sm" aria-label={`Manage vendors for ${event.name}`}>
                            <Store className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Link href={`/admin/events/${event.id}/edit`}>
                          <Button variant="ghost" size="sm" aria-label={`Edit ${event.name}`}>
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(event.id)}
                          aria-label={`Delete ${event.name}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" aria-hidden="true" />
                        </Button>
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
