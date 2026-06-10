import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/layout/providers";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { UnverifiedBanner } from "@/components/layout/unverified-banner";
import { WebVitals } from "@/components/WebVitals";
import { ErrorAnalyticsBridge } from "@/components/ErrorAnalyticsBridge";
import { OrganizationSchema } from "@/components/seo/OrganizationSchema";

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
    // Design System keystone PR 4 (2026-06-07):
    //   - `suppressHydrationWarning` is REQUIRED by next-themes — their
    //     pre-hydration <script> mutates className before React renders,
    //     which would otherwise emit a "Warning: Prop className did not
    //     match" hydration error. Per next-themes docs.
    //   - Dropped hardcoded `bg-cream` from the className. The page bg
    //     is now driven by the `:root { --background }` CSS var (defined
    //     in globals.css PR 1) which the body styles consume. Keeping
    //     `bg-cream` here would override the .dark theme on <html>.
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://www.googletagmanager.com" />
        <link rel="preconnect" href="https://challenges.cloudflare.com" />
        <link rel="dns-prefetch" href="https://www.google-analytics.com" />
      </head>
      <body className="antialiased min-h-screen flex flex-col">
        <OrganizationSchema />
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

        IMPORTANT — script placement: these <script> tags must live INSIDE
        <body>. Previously placed as direct children of <html> (between
        </body> and </html>), they caused a site-wide React #418 hydration
        error: SSR emitted them at end-of-document while React 19's client
        reconciler clustered inline scripts near OrganizationSchema's
        JSON-LD at the top of <body>. The position mismatch then triggered
        secondary "Cannot read properties of null (reading 'parentNode')"
        TypeErrors as React's recovery code tried to swap orphaned
        streaming markers. Root-caused via playwright browser repro
        2026-05-18 (SSR-vs-hydrated DOM diff at byte 893). Keep these
        inside <body>.

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
if (!window.__ga4Inited) {
  window.__ga4Inited = true;
  gtag('js', new Date());
  gtag('config', '${process.env.NEXT_PUBLIC_GA_ID}');
}`,
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
      </body>
    </html>
  );
}
