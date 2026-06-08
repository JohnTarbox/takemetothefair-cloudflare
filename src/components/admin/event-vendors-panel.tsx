"use client";

import { useState } from "react";
import Link from "next/link";
import { Store, UserPlus, ExternalLink, Search } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateRange } from "@/lib/utils";
import { pluralize } from "@/lib/text";

interface EventWithVendorCount {
  id: string;
  name: string;
  slug: string;
  startDate: Date | null;
  endDate: Date | null;
  venue: {
    city: string | null;
    state: string | null;
  } | null;
  vendorCount: number;
}

interface EventVendorsPanelProps {
  events: EventWithVendorCount[];
}

export function EventVendorsPanel({ events }: EventVendorsPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredEvents = events.filter(
    (event) =>
      event.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.venue?.city?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.venue?.state?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-foreground">Manage Event Vendors</h2>
        <Link href="/admin/events">
          <Button variant="outline" size="sm">
            View All Events
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search events..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        {events.length === 0 ? (
          <p className="text-muted-foreground py-4">No upcoming events</p>
        ) : filteredEvents.length === 0 ? (
          <p className="text-muted-foreground py-4">No events match your search</p>
        ) : (
          <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
            {filteredEvents.map((event) => (
              <div key={event.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/events/${event.slug}`}
                        className="font-medium text-foreground hover:text-blue-600 truncate"
                      >
                        {event.name}
                      </Link>
                      <Link href={`/events/${event.slug}`} target="_blank">
                        <ExternalLink className="w-3 h-3 text-muted-foreground" />
                      </Link>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {formatDateRange(event.startDate, event.endDate)}
                      {event.venue && ` • ${event.venue.city}, ${event.venue.state}`}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant={event.vendorCount > 0 ? "success" : "default"}>
                        <Store className="w-3 h-3 mr-1" />
                        {event.vendorCount} vendor{event.vendorCount !== 1 ? "s" : ""}
                      </Badge>
                    </div>
                  </div>
                  <Link href={`/admin/events/${event.id}/vendors`}>
                    <Button size="sm">
                      <UserPlus className="w-4 h-4 mr-1" />
                      Manage
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}

        {events.length > 0 && (
          <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
            Showing {filteredEvents.length} of {pluralize(events.length, "upcoming event")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
