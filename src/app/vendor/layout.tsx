import { redirect } from "next/navigation";
import Link from "next/link";
import { Store, FileText, Settings } from "lucide-react";
import { auth } from "@/lib/auth";

const vendorNav = [
  { name: "My Profile", href: "/vendor/profile", icon: Store },
  { name: "Applications", href: "/vendor/applications", icon: FileText },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
];

export default async function VendorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect("/login?callbackUrl=/vendor/profile");
  }

  if (session.user.role !== "VENDOR" && session.user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="flex">
        <aside className="w-64 bg-white border-r border-gray-200 min-h-[calc(100vh-4rem)]">
          <div className="p-4">
            <h2 className="text-lg font-semibold text-gray-900">Vendor Portal</h2>
          </div>
          <nav className="p-4 space-y-1">
            {vendorNav.map((item) => (
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
