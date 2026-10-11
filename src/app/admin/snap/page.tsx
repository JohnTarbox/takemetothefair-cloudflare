/**
 * /admin/snap — OPE-1341 "Snap booth" capture page. ADMIN-only via the admin
 * layout. Installable on its own (`snap-manifest.json`, start_url + scope
 * `/admin/snap`) so it opens full-screen from the phone's home screen.
 */
import type { Metadata, Viewport } from "next";
import { SnapCapture } from "./snap-capture";

export const metadata: Metadata = {
  title: "Snap booth",
  manifest: "/snap-manifest.json",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Snap booth", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#111827",
  width: "device-width",
  initialScale: 1,
};

export default function SnapPage() {
  return <SnapCapture />;
}
