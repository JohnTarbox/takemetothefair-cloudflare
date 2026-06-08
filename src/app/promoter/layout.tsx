import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, Plus, Settings } from "lucide-react";
import { auth } from "@/lib/auth";

const promoterNav = [
  { name: "My Events", href: "/promoter/events", icon: Calendar },
  { name: "Create Event", href: "/promoter/events/new", icon: Plus },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
];

export default async function PromoterLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session) {
    redirect("/login?callbackUrl=/promoter/events");
  }

  if (session.user.role !== "PROMOTER" && session.user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-muted">
      <div className="flex">
        <aside className="w-64 bg-card border-r border-border min-h-[calc(100vh-4rem)]">
          <div className="p-4">
            <h2 className="text-lg font-semibold text-foreground">Promoter Portal</h2>
          </div>
          <nav className="p-4 space-y-1">
            {promoterNav.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2 text-foreground rounded-lg hover:bg-muted transition-colors"
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
