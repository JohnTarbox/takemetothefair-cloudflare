import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, Heart, Settings, User } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { userFavorites } from "@/lib/db/schema";
import { eq, count } from "drizzle-orm";

export const runtime = "edge";


async function getUserStats(userId: string) {
  try {
    const db = getCloudflareDb();
    const result = await db
      .select({ count: count() })
      .from(userFavorites)
      .where(eq(userFavorites.userId, userId));

    return { favoritesCount: result[0]?.count || 0 };
  } catch (e) {
    console.error("Error fetching user stats:", e);
    return { favoritesCount: 0 };
  }
}

export default async function DashboardPage() {
  const session = await auth();

  if (!session) {
    redirect("/login?callbackUrl=/dashboard");
  }

  const stats = await getUserStats(session.user.id);

  const quickLinks = [
    {
      name: "Browse Events",
      description: "Find upcoming fairs and festivals",
      href: "/events",
      icon: Calendar,
    },
    {
      name: "My Favorites",
      description: `${stats.favoritesCount} saved items`,
      href: "/dashboard/favorites",
      icon: Heart,
    },
    {
      name: "Account Settings",
      description: "Manage your profile",
      href: "/dashboard/settings",
      icon: Settings,
    },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back, {session.user.name || "Friend"}!
        </h1>
        <p className="mt-1 text-gray-600">
          Here&apos;s what&apos;s happening with your account
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {quickLinks.map((link) => (
          <Link key={link.name} href={link.href}>
            <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-blue-50 flex items-center justify-center">
                    <link.icon className="w-6 h-6 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900">{link.name}</h3>
                    <p className="text-sm text-gray-500">{link.description}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Your Profile</h2>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
              {session.user.image ? (
                <img
                  src={session.user.image}
                  alt=""
                  className="w-16 h-16 rounded-full object-cover"
                />
              ) : (
                <User className="w-8 h-8 text-blue-600" />
              )}
            </div>
            <div>
              <p className="font-medium text-gray-900">
                {session.user.name || "No name set"}
              </p>
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
                <p className="text-sm text-gray-500">
                  Manage your events and submissions
                </p>
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
                <p className="text-sm text-gray-500">
                  Manage your profile and event applications
                </p>
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
                <p className="text-sm text-gray-500">
                  Manage all events, venues, and users
                </p>
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
