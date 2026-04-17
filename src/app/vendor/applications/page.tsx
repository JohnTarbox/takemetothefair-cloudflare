import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, FileText, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events, venues } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { VendorApplicationRow } from "@/components/vendor/vendor-application-row";
import type { VendorApplicationRowData } from "@/components/vendor/vendor-application-row";

export const runtime = "edge";

async function getApplications(userId: string): Promise<VendorApplicationRowData[]> {
  const db = getCloudflareDb();

  try {
    const vendorResults = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, userId))
      .limit(1);

    if (vendorResults.length === 0) return [];

    const vendor = vendorResults[0];

    const applicationResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(eventVendors.vendorId, vendor.id))
      .orderBy(desc(eventVendors.createdAt));

    return applicationResults
      .filter((a) => a.events !== null)
      .map((a) => ({
        id: a.event_vendors.id,
        status: a.event_vendors.status,
        boothInfo: a.event_vendors.boothInfo,
        event: {
          name: a.events!.name,
          slug: a.events!.slug,
          description: a.events!.description,
          startDate: a.events!.startDate,
          endDate: a.events!.endDate,
          venue: a.venues
            ? {
                name: a.venues.name,
                address: a.venues.address,
                city: a.venues.city,
                state: a.venues.state,
                zip: a.venues.zip,
              }
            : null,
        },
      }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching applications",
      error: e,
      source: "app/vendor/applications/page.tsx:getApplications",
      context: { userId },
    });
    return [];
  }
}

// Active statuses that represent a real commitment (not rejected/withdrawn/cancelled)
const ACTIVE_STATUSES = new Set([
  "INVITED",
  "INTERESTED",
  "APPLIED",
  "WAITLISTED",
  "APPROVED",
  "CONFIRMED",
]);

function detectConflicts(applications: VendorApplicationRowData[]): Map<string, string[]> {
  const conflicts = new Map<string, string[]>();
  const active = applications.filter((a) => ACTIVE_STATUSES.has(a.status));

  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    if (!a.event.startDate || !a.event.endDate) continue;
    const aStart = new Date(a.event.startDate).getTime();
    const aEnd = new Date(a.event.endDate).getTime();

    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      if (!b.event.startDate || !b.event.endDate) continue;
      const bStart = new Date(b.event.startDate).getTime();
      const bEnd = new Date(b.event.endDate).getTime();

      if (aStart <= bEnd && aEnd >= bStart) {
        const aConflicts = conflicts.get(a.id) || [];
        aConflicts.push(b.event.name);
        conflicts.set(a.id, aConflicts);

        const bConflicts = conflicts.get(b.id) || [];
        bConflicts.push(a.event.name);
        conflicts.set(b.id, bConflicts);
      }
    }
  }
  return conflicts;
}

// The set of filter tabs shown above the list. "ALL" is a pseudo-status that
// means no filter applied.
const TABS: Array<{ key: string; label: string; match?: (s: string) => boolean }> = [
  { key: "ALL", label: "All" },
  { key: "APPLIED", label: "Applied", match: (s) => s === "APPLIED" || s === "WAITLISTED" },
  { key: "CONFIRMED", label: "Confirmed", match: (s) => s === "APPROVED" || s === "CONFIRMED" },
  { key: "REJECTED", label: "Rejected", match: (s) => s === "REJECTED" },
  { key: "WITHDRAWN", label: "Withdrawn", match: (s) => s === "WITHDRAWN" || s === "CANCELLED" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; highlight?: string }>;
}

export default async function VendorApplicationsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const params = await searchParams;
  const activeTab = (params.status || "ALL").toUpperCase();
  const highlightId = params.highlight || null;

  const applications = await getApplications(session.user.id);
  const conflicts = detectConflicts(applications);

  // Filter based on active tab. Tab counts are computed from the unfiltered list.
  const filtered = (() => {
    const tab = TABS.find((t) => t.key === activeTab) ?? TABS[0];
    if (!tab.match) return applications;
    return applications.filter((a) => tab.match!(a.status));
  })();

  const tabCounts: Record<string, number> = Object.fromEntries(
    TABS.map((t) => [
      t.key,
      t.match ? applications.filter((a) => t.match!(a.status)).length : applications.length,
    ])
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Event Applications</h1>
        <p className="mt-1 text-gray-600">Track your applications to participate in events</p>
      </div>

      {applications.length > 0 && (
        <div
          role="tablist"
          aria-label="Filter applications by status"
          className="mb-6 flex flex-wrap gap-2 border-b border-stone-100 pb-2"
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            const count = tabCounts[tab.key];
            const href =
              tab.key === "ALL" ? "/vendor/applications" : `/vendor/applications?status=${tab.key}`;
            return (
              <Link
                key={tab.key}
                href={href}
                role="tab"
                aria-selected={isActive}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  isActive ? "bg-navy text-white" : "bg-stone-100 text-stone-900 hover:bg-stone-300"
                }`}
              >
                {tab.label}
                <span className={`text-xs ${isActive ? "text-white/80" : "text-stone-600"}`}>
                  {count}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {applications.length === 0 ? (
        <Card className="border-stone-100 bg-stone-50">
          <CardContent className="py-12 text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-sage-50 flex items-center justify-center mb-4">
              <FileText className="w-7 h-7 text-sage-700" aria-hidden />
            </div>
            <h3 className="text-lg font-semibold text-stone-900">No applications yet</h3>
            <p className="mt-1 text-sm text-stone-600 max-w-md mx-auto">
              Browse upcoming events and apply to participate as a vendor. Make sure your profile is
              complete first — promoters look at it before accepting.
            </p>
            <div className="mt-6 flex flex-wrap gap-3 justify-center">
              <Link href="/events">
                <Button>
                  <Calendar className="w-4 h-4 mr-2" />
                  Browse events
                </Button>
              </Link>
              <Link href="/vendor/suggest-event">
                <Button variant="outline">
                  <Sparkles className="w-4 h-4 mr-2" />
                  Suggest an event
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="border-stone-100 bg-stone-50">
          <CardContent className="py-10 text-center text-stone-600">
            <p className="text-sm">
              No applications in this tab.{" "}
              <Link href="/vendor/applications" className="text-navy hover:underline">
                View all
              </Link>
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filtered.map((app) => (
            <VendorApplicationRow
              key={app.id}
              application={app}
              conflicts={conflicts.get(app.id) ?? []}
              highlighted={highlightId === app.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
