import type { Metadata } from "next";
import { GoogleAnalytics } from "@next/third-parties/google";
import "./globals.css";
import { Providers } from "@/components/layout/providers";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";

export const metadata: Metadata = {
  title: "Meet Me at the Fair - Discover Local Fairs & Events",
  description:
    "Find fairs, festivals, and community events in your area. Connect with vendors and promoters.",
  metadataBase: new URL("https://meetmeatthefair.com"),
  openGraph: {
    title: "Meet Me at the Fair",
    description: "Find fairs, festivals, and community events in your area. Connect with vendors and promoters.",
    url: "https://meetmeatthefair.com",
    siteName: "Meet Me at the Fair",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Meet Me at the Fair",
    description: "Find fairs, festivals, and community events in your area. Connect with vendors and promoters.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen flex flex-col">
        <Providers>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </Providers>
      </body>
      {process.env.NEXT_PUBLIC_GA_ID && (
        <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_ID} />
      )}
    </html>
  );
}
