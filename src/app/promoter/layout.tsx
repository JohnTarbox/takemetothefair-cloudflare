import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, Plus, Settings } from "lucide-react";
import { auth } from "@/lib/auth";

const promoterNav = [
  { name: "My Events", href: "/promoter/events", icon: Calendar },
  { name: "Create Event", href: "/promoter/events/new", icon: Plus },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
];

export default async function PromoterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect("/login?callbackUrl=/promoter/events");
  }

  if (session.user.role !== "PROMOTER" && session.user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="flex">
        <aside className="w-64 bg-white border-r border-gray-200 min-h-[calc(100vh-4rem)]">
          <div className="p-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Promoter Portal
            </h2>
          </div>
          <nav className="p-4 space-y-1">
            {promoterNav.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <item.icon className="w-5 h-5" />
                {item.name}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
