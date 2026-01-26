"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";

export const runtime = "edge";

interface Venue {
  id: string;
  name: string;
  slug: string;
  city: string;
  state: string;
  status: string;
  capacity: number | null;
  _count: { events: number };
}

export default function AdminVenuesPage() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "name",
    direction: "asc",
  });

  useEffect(() => {
    fetchVenues();
  }, []);

  const fetchVenues = async () => {
    try {
      const res = await fetch("/api/admin/venues");
      const data = await res.json() as Venue[];
      setVenues(data);
    } catch (error) {
      console.error("Failed to fetch venues:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this venue?")) return;

    try {
      const res = await fetch(`/api/admin/venues/${id}`, { method: "DELETE" });
      if (res.ok) {
        setVenues(venues.filter((v) => v.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete venue:", error);
    }
  };

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const sortedVenues = sortData(venues, sortConfig, {
    name: (v) => v.name,
    location: (v) => `${v.city}, ${v.state}`,
    capacity: (v) => v.capacity || 0,
    events: (v) => v._count.events,
    status: (v) => v.status,
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
        <h1 className="text-2xl font-bold text-gray-900">Manage Venues</h1>
        <Link href="/admin/venues/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Venue
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <p className="text-sm text-gray-600">{venues.length} venues total</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <SortableHeader
                    column="name"
                    label="Venue"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="location"
                    label="Location"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="capacity"
                    label="Capacity"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="events"
                    label="Events"
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
                {sortedVenues.map((venue) => (
                  <tr key={venue.id} className="border-b border-gray-100">
                    <td className="py-3 px-4 font-medium text-gray-900">
                      {venue.name}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {venue.city}, {venue.state}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {venue.capacity?.toLocaleString() || "-"}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {venue._count.events}
                    </td>
                    <td className="py-3 px-4">
                      <Badge
                        variant={
                          venue.status === "ACTIVE" ? "success" : "default"
                        }
                      >
                        {venue.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/venues/${venue.slug}`}>
                          <Button variant="ghost" size="sm" aria-label={`View ${venue.name}`}>
                            <Eye className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Link href={`/admin/venues/${venue.id}/edit`}>
                          <Button variant="ghost" size="sm" aria-label={`Edit ${venue.name}`}>
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(venue.id)}
                          aria-label={`Delete ${venue.name}`}
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
