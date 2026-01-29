import { redirect } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Calendar,
  MapPin,
  Store,
  Users,
  ClipboardList,
  Megaphone,
  Download,
  GitMerge,
  Link2,
  Database,
  FileWarning,
} from "lucide-react";
import { auth } from "@/lib/auth";

const adminNav = [
  { name: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { name: "Events", href: "/admin/events", icon: Calendar },
  { name: "Import Events", href: "/admin/import", icon: Download },
  { name: "Import from URL", href: "/admin/import-url", icon: Link2 },
  { name: "Venues", href: "/admin/venues", icon: MapPin },
  { name: "Vendors", href: "/admin/vendors", icon: Store },
  { name: "Promoters", href: "/admin/promoters", icon: Megaphone },
  { name: "Users", href: "/admin/users", icon: Users },
  { name: "Submissions", href: "/admin/submissions", icon: ClipboardList },
  { name: "Duplicates", href: "/admin/duplicates", icon: GitMerge },
  { name: "Database", href: "/admin/database", icon: Database },
  { name: "Error Logs", href: "/admin/logs", icon: FileWarning },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session || session.user.role !== "ADMIN") {
    redirect("/login?callbackUrl=/admin");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="flex">
        <aside className="w-64 bg-white border-r border-gray-200 min-h-[calc(100vh-4rem)]">
          <nav className="p-4 space-y-1">
            {adminNav.map((item) => (
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
