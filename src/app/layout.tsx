import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
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
      {/*
        GA4 install — plain <script> elements, NOT next/script's <Script>.
        Next.js App Router puts <Script strategy="afterInteractive"> content
        into the RSC payload (escaped string) and injects it client-side,
        which means: (a) the loader src never appears as a literal <script>
        tag in SSR HTML, (b) the inline init renders only as escaped JSON,
        not executable JavaScript. Same problem as @next/third-parties's
        <GoogleAnalytics> — see PR #107 / #108 for the iteration.
        Plain <script> in JSX renders directly to SSR HTML (same pattern
        the CF Insights beacon below has used since day one). `async` lets
        the browser parse the rest of the document while gtag.js loads.

        XSS-safety: the inline init's content is built from
        process.env.NEXT_PUBLIC_GA_ID, a build-time env var sourced from a
        GitHub Actions secret. It is NOT user-controllable runtime input —
        no sanitizer needed. The G- value is also a public, low-entropy
        identifier (it ships to every browser anyway).
      */}
      {process.env.NEXT_PUBLIC_GA_ID && (
        <>
          <script
            async
            src={`https://www.googletagmanager.com/gtag/js?id=${process.env.NEXT_PUBLIC_GA_ID}`}
          />
          <script
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${process.env.NEXT_PUBLIC_GA_ID}');`,
            }}
          />
        </>
      )}
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
