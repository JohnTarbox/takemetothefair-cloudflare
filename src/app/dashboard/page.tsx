import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
  Calendar,
  Heart,
  Settings,
  User,
  CheckCircle2,
  Circle,
  ArrowRight,
  Mail,
  MapPin,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  userFavorites,
  users,
  vendors,
  promoters,
  events,
  eventVendors,
  venues,
} from "@/lib/db/schema";
import { eq, count, and, gte, asc } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { logError } from "@/lib/logger";
import { formatDateRange } from "@/lib/utils";
import { computeVendorCompleteness } from "@/lib/vendor-completeness";

export const runtime = "edge";

interface DashboardState {
  emailVerified: boolean;
  favoritesCount: number;
  vendor?: { id: string; applicationCount: number; profileComplete: boolean };
  promoter?: { id: string; eventCount: number; companyComplete: boolean };
}

async function getDashboardState(
  userId: string,
  role: "USER" | "VENDOR" | "PROMOTER" | "ADMIN"
): Promise<DashboardState> {
  const db = getCloudflareDb();

  const state: DashboardState = {
    emailVerified: false,
    favoritesCount: 0,
  };

  try {
    const [user] = await db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    state.emailVerified = !!user?.emailVerified;
  } catch (e) {
    await logError(db, {
      message: "Error fetching user verification status",
      error: e,
      source: "app/dashboard/page.tsx:getDashboardState",
      context: { userId },
    });
  }

  try {
    const result = await db
      .select({ count: count() })
      .from(userFavorites)
      .where(eq(userFavorites.userId, userId));
    state.favoritesCount = result[0]?.count ?? 0;
  } catch {
    /* non-fatal */
  }

  if (role === "VENDOR" || role === "ADMIN") {
    try {
      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.userId, userId),
        columns: {
          id: true,
          logoUrl: true,
          description: true,
          products: true,
          contactEmail: true,
          contactPhone: true,
          city: true,
          state: true,
        },
      });
      if (vendor) {
        const appResult = await db
          .select({ count: count() })
          .from(eventVendors)
          .where(eq(eventVendors.vendorId, vendor.id));
        state.vendor = {
          id: vendor.id,
          applicationCount: appResult[0]?.count ?? 0,
          profileComplete: computeVendorCompleteness(vendor).complete,
        };
      }
    } catch {
      /* non-fatal */
    }
  }

  if (role === "PROMOTER" || role === "ADMIN") {
    try {
      const promoter = await db.query.promoters.findFirst({
        where: eq(promoters.userId, userId),
        columns: { id: true, description: true, website: true, contactEmail: true },
      });
      if (promoter) {
        const eventResult = await db
          .select({ count: count() })
          .from(events)
          .where(eq(events.promoterId, promoter.id));
        const companyComplete =
          !!promoter.description && (!!promoter.website || !!promoter.contactEmail);
        state.promoter = {
          id: promoter.id,
          eventCount: eventResult[0]?.count ?? 0,
          companyComplete,
        };
      }
    } catch {
      /* non-fatal */
    }
  }

  return state;
}

async function getUpcomingEvents() {
  try {
    const db = getCloudflareDb();
    const results = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(and(isPublicEventStatus(), gte(events.endDate, new Date())))
      .orderBy(asc(events.startDate))
      .limit(3);

    return results.map((r) => ({
      id: r.events.id,
      slug: r.events.slug,
      name: r.events.name,
      startDate: r.events.startDate,
      endDate: r.events.endDate,
      imageUrl: r.events.imageUrl,
      venue: r.venues ? { name: r.venues.name, city: r.venues.city, state: r.venues.state } : null,
    }));
  } catch {
    return [];
  }
}

type ChecklistItem = {
  label: string;
  done: boolean;
  href: string;
  cta: string;
};

function buildChecklist(
  role: "USER" | "VENDOR" | "PROMOTER" | "ADMIN",
  state: DashboardState
): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  items.push({
    label: "Verify your email address",
    done: state.emailVerified,
    href: "#",
    cta: "Check your inbox",
  });

  if (role === "VENDOR") {
    items.push({
      label: "Complete your vendor profile",
      done: state.vendor?.profileComplete ?? false,
      href: "/vendor/profile",
      cta: "Edit profile",
    });
    items.push({
      label: "Apply to your first event",
      done: (state.vendor?.applicationCount ?? 0) > 0,
      href: "/events",
      cta: "Browse events",
    });
  } else if (role === "PROMOTER") {
    items.push({
      label: "Complete your company profile",
      done: state.promoter?.companyComplete ?? false,
      href: "/dashboard/settings",
      cta: "Edit company",
    });
    items.push({
      label: "Create your first event",
      done: (state.promoter?.eventCount ?? 0) > 0,
      href: "/promoter/events/new",
      cta: "Create event",
    });
  } else {
    items.push({
      label: "Save an event to your favorites",
      done: state.favoritesCount > 0,
      href: "/events",
      cta: "Browse events",
    });
    items.push({
      label: "Fill out your profile",
      done: false, // USER role has minimal profile; always surface Settings
      href: "/dashboard/settings",
      cta: "Open settings",
    });
  }

  return items;
}

export default async function DashboardPage() {
  const session = await auth();

  if (!session) {
    redirect("/login?callbackUrl=/dashboard");
  }

  const [state, upcoming] = await Promise.all([
    getDashboardState(session.user.id, session.user.role),
    getUpcomingEvents(),
  ]);

  const checklist = buildChecklist(session.user.role, state);
  const incompleteCount = checklist.filter((i) => !i.done).length;
  const totalSteps = checklist.length;
  const doneSteps = totalSteps - incompleteCount;
  const showChecklist = incompleteCount > 0;

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back, {session.user.name || "Friend"}!
        </h1>
        <p className="mt-1 text-gray-600">Here&apos;s what&apos;s happening with your account</p>
      </div>

      {showChecklist && (
        <Card className="mb-8 border-amber-dark/30 bg-amber-light">
          <CardHeader>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-stone-900">
                Get started ({doneSteps} of {totalSteps} complete)
              </h2>
              <span className="text-sm text-stone-600">
                {incompleteCount} step{incompleteCount > 1 ? "s" : ""} left
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {checklist.map((item) => (
                <li key={item.label} className="flex items-start gap-3">
                  {item.done ? (
                    <CheckCircle2
                      className="w-5 h-5 text-sage-700 flex-shrink-0 mt-0.5"
                      aria-hidden
                    />
                  ) : (
                    <Circle className="w-5 h-5 text-stone-600 flex-shrink-0 mt-0.5" aria-hidden />
                  )}
                  <div className="flex-1 flex flex-wrap items-baseline justify-between gap-2">
                    <span
                      className={`text-sm ${item.done ? "text-stone-600 line-through" : "text-stone-900"}`}
                    >
                      {item.label}
                    </span>
                    {!item.done && item.href !== "#" && (
                      <Link
                        href={item.href}
                        className="text-sm font-medium text-navy hover:underline inline-flex items-center gap-1"
                      >
                        {item.cta}
                        <ArrowRight className="w-3 h-3" />
                      </Link>
                    )}
                    {!item.done && item.href === "#" && (
                      <span className="text-sm text-stone-600 inline-flex items-center gap-1">
                        <Mail className="w-3 h-3" />
                        {item.cta}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Link href="/events">
          <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-amber-light flex items-center justify-center">
                  <Calendar className="w-6 h-6 text-amber-dark" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Browse Events</h3>
                  <p className="text-sm text-gray-500">Find upcoming fairs and festivals</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/dashboard/favorites">
          <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-terracotta-light flex items-center justify-center">
                  <Heart className="w-6 h-6 text-terracotta" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">My Favorites</h3>
                  <p className="text-sm text-gray-500">
                    {state.favoritesCount} saved item{state.favoritesCount === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/dashboard/settings">
          <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-stone-100 flex items-center justify-center">
                  <Settings className="w-6 h-6 text-navy" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Account Settings</h3>
                  <p className="text-sm text-gray-500">Manage your profile</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {upcoming.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-gray-900">What&apos;s next</h2>
              <Link
                href="/events"
                className="text-sm font-medium text-navy hover:underline inline-flex items-center gap-1"
              >
                See all events
                <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {upcoming.map((event) => (
                <Link key={event.id} href={`/events/${event.slug}`} className="block group">
                  <div className="aspect-video relative rounded-lg overflow-hidden bg-stone-100 mb-2">
                    {event.imageUrl && (
                      <Image
                        src={event.imageUrl}
                        alt={event.name}
                        fill
                        sizes="(max-width: 640px) 100vw, 33vw"
                        className="object-cover"
                      />
                    )}
                  </div>
                  <h3 className="text-sm font-semibold text-gray-900 line-clamp-2 group-hover:text-navy">
                    {event.name}
                  </h3>
                  <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {formatDateRange(event.startDate, event.endDate)}
                  </p>
                  {event.venue && (
                    <p className="text-xs text-gray-500 flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {event.venue.city}, {event.venue.state}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Your Profile</h2>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-stone-100 flex items-center justify-center">
              {session.user.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.user.image}
                  alt=""
                  className="w-16 h-16 rounded-full object-cover"
                />
              ) : (
                <User className="w-8 h-8 text-navy" />
              )}
            </div>
            <div>
              <p className="font-medium text-gray-900">{session.user.name || "No name set"}</p>
              <p className="text-sm text-gray-500">{session.user.email}</p>
              <p className="text-xs text-gray-400 mt-1 capitalize">
                {session.user.role.toLowerCase()} Account
              </p>
            </div>
          </div>
          <div className="mt-6">
            <Link href="/dashboard/settings">
              <Button variant="outline">Edit Profile</Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {(session.user.role === "PROMOTER" || session.user.role === "ADMIN") && (
        <Card className="mt-6">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-gray-900">Promoter Portal</h3>
                <p className="text-sm text-gray-500">Manage your events and submissions</p>
              </div>
              <Link href="/promoter/events">
                <Button>Go to Promoter Portal</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {session.user.role === "VENDOR" && (
        <Card className="mt-6">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-gray-900">Vendor Portal</h3>
                <p className="text-sm text-gray-500">Manage your profile and event applications</p>
              </div>
              <Link href="/vendor/profile">
                <Button>Go to Vendor Portal</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {session.user.role === "ADMIN" && (
        <Card className="mt-6">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-gray-900">Admin Dashboard</h3>
                <p className="text-sm text-gray-500">Manage all events, venues, and users</p>
              </div>
              <Link href="/admin">
                <Button>Go to Admin Dashboard</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
