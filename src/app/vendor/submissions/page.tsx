import Link from "next/link";
import { Calendar, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { formatDateRange } from "@/lib/utils";
import { redirect } from "next/navigation";

const statusConfig: Record<
  string,
  { label: string; variant: "default" | "success" | "warning" | "danger" | "info" }
> = {
  TENTATIVE: { label: "Tentative", variant: "info" },
  APPROVED: { label: "Approved", variant: "success" },
  PENDING: { label: "Pending Review", variant: "warning" },
  REJECTED: { label: "Rejected", variant: "danger" },
  DRAFT: { label: "Draft", variant: "default" },
  CANCELLED: { label: "Cancelled", variant: "default" },
};

async function getSubmissions(userId: string) {
  const db = getCloudflareDb();

  const results = await db
    .select()
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(eq(events.submittedByUserId, userId))
    .orderBy(events.createdAt);

  return results.map((r) => ({
    ...r.events,
    venue: r.venues,
  }));
}

export default async function VendorSubmissionsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/vendor/submissions");
  }

  const submissions = await getSubmissions(session.user.id);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Submissions</h1>
          <p className="text-gray-600 mt-1">Events you&apos;ve suggested to the platform</p>
        </div>
        <Link href="/vendor/suggest-event">
          <Button>
            <Calendar className="w-4 h-4 mr-2" />
            Suggest Event
          </Button>
        </Link>
      </div>

      {submissions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Calendar className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-600 mb-4">You haven&apos;t submitted any events yet.</p>
            <Link href="/vendor/suggest-event">
              <Button>Suggest Your First Event</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <p className="text-sm text-gray-600">
              {submissions.length} submission{submissions.length !== 1 ? "s" : ""}
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">Event</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">Dates</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                      Status
                    </th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((event) => {
                    const config = statusConfig[event.status] || {
                      label: event.status,
                      variant: "default" as const,
                    };
                    const isPublic = event.status === "TENTATIVE" || event.status === "APPROVED";

                    return (
                      <tr key={event.id} className="border-b border-gray-100">
                        <td className="py-3 px-4">
                          <p className="font-medium text-gray-900">{event.name}</p>
                          {event.venue && (
                            <p className="text-sm text-gray-500">
                              {event.venue.name}, {event.venue.city}
                            </p>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-600">
                          {formatDateRange(event.startDate, event.endDate)}
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={config.variant}>{config.label}</Badge>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {isPublic && (
                            <Link
                              href={`/events/${event.slug}`}
                              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
                            >
                              View <ExternalLink className="w-3 h-3" />
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
