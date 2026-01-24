import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Eye, Pencil, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

const statusColors: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "default",
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "default",
};

async function getPromoterEvents(userId: string) {
  try {
    const promoter = await prisma.promoter.findUnique({
      where: { userId },
      include: {
        events: {
          include: {
            venue: { select: { name: true } },
            _count: { select: { eventVendors: true } },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    return promoter?.events || [];
  } catch {
    return [];
  }
}

export default async function PromoterEventsPage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const events = await getPromoterEvents(session.user.id);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Events</h1>
          <p className="mt-1 text-gray-600">
            Manage your events and track their status
          </p>
        </div>
        <Link href="/promoter/events/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Create Event
          </Button>
        </Link>
      </div>

      {events.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Calendar className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900">No events yet</h3>
            <p className="mt-1 text-gray-500">
              Get started by creating your first event
            </p>
            <Link href="/promoter/events/new" className="mt-4 inline-block">
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Create Event
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <p className="text-sm text-gray-600">{events.length} events</p>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-gray-100">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="py-4 flex items-center justify-between"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <h3 className="font-medium text-gray-900">{event.name}</h3>
                      <Badge variant={statusColors[event.status]}>
                        {event.status}
                      </Badge>
                      {event.featured && (
                        <Badge variant="warning">Featured</Badge>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-4 text-sm text-gray-500">
                      <span>{event.venue.name}</span>
                      <span>{formatDate(event.startDate)}</span>
                      <span>{event._count.eventVendors} vendors</span>
                      <span>{event.viewCount} views</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {event.status === "APPROVED" && (
                      <Link href={`/events/${event.slug}`}>
                        <Button variant="ghost" size="sm">
                          <Eye className="w-4 h-4" />
                        </Button>
                      </Link>
                    )}
                    <Link href={`/promoter/events/${event.id}/edit`}>
                      <Button variant="ghost" size="sm">
                        <Pencil className="w-4 h-4" />
                      </Button>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
