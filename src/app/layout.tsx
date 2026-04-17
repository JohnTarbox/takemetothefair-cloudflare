import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "./globals.css";
import { Providers } from "@/components/layout/providers";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { UnverifiedBanner } from "@/components/layout/unverified-banner";
import { WebVitals } from "@/components/WebVitals";
import { ErrorAnalyticsBridge } from "@/components/ErrorAnalyticsBridge";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Meet Me at the Fair - Discover Local Fairs & Events",
  description:
    "Find fairs, festivals, and community events in your area. Connect with vendors and promoters.",
  metadataBase: new URL("https://meetmeatthefair.com"),
  openGraph: {
    title: "Meet Me at the Fair",
    description:
      "Find fairs, festivals, and community events in your area. Connect with vendors and promoters.",
    url: "https://meetmeatthefair.com",
    siteName: "Meet Me at the Fair",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Discover Local Fairs, Festivals & Events",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Meet Me at the Fair",
    description:
      "Find fairs, festivals, and community events in your area. Connect with vendors and promoters.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`bg-cream ${fraunces.variable} ${inter.variable}`}>
      <head>
        <link rel="preconnect" href="https://www.googletagmanager.com" />
        <link rel="preconnect" href="https://challenges.cloudflare.com" />
        <link rel="dns-prefetch" href="https://www.google-analytics.com" />
      </head>
      <body className="antialiased min-h-screen flex flex-col">
        <Providers>
          <WebVitals />
          <ErrorAnalyticsBridge />
          <Header />
          <UnverifiedBanner />
          <main id="main-content" className="flex-1">
            {children}
          </main>
          <Footer />
        </Providers>
      </body>
      {process.env.NEXT_PUBLIC_GA_ID && <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_ID} />}
      {process.env.NEXT_PUBLIC_CF_BEACON_TOKEN && (
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon={`{"token": "${process.env.NEXT_PUBLIC_CF_BEACON_TOKEN}"}`}
        />
      )}
    </html>
  );
}
