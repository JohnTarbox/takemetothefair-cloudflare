/**
 * OPE-122 — public performers index. Closes the discovery gap from OPE-115:
 * detail pages existed + were in the sitemap, but there was no browse/search
 * entry point (mirrors the /vendors and /promoters index pattern). The full
 * public set is server-rendered; PerformerBrowser adds client-side name search
 * + act-category filtering (catalog is small, like /promoters — pagination
 * deferred until it grows).
 */
import type { Metadata } from "next";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { PerformerBrowser } from "@/components/performers/PerformerBrowser";
import { listPublicPerformers } from "@/lib/performers/list-public";

export const revalidate = 3600;
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Performers & Entertainment | Meet Me at the Fair",
  description:
    "Browse the acts, bands, and entertainers who appear at fairs and festivals across New England — find where your favorite performers are playing next.",
  alternates: { canonical: "https://meetmeatthefair.com/performers" },
  openGraph: {
    title: "Performers & Entertainment | Meet Me at the Fair",
    description:
      "Browse the acts, bands, and entertainers who appear at fairs and festivals across New England.",
    url: "https://meetmeatthefair.com/performers",
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Performers & Entertainment",
      },
    ],
  },
};

async function getPerformers() {
  const db = getCloudflareDb();
  try {
    return await listPublicPerformers(db);
  } catch (e) {
    await logError(db, {
      message: "Error listing performers",
      error: e,
      source: "app/performers/page.tsx:getPerformers",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/performers/page.tsx:getPerformers", e);
  }
}

export default async function PerformersIndex() {
  const list = await getPerformers();

  return (
    <>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Performers", url: "https://meetmeatthefair.com/performers" },
        ]}
      />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-2">
          Performers &amp; Entertainment
        </h1>
        <p className="text-muted-foreground mb-8">
          The acts, bands, and entertainers who appear at fairs and festivals across New England.
        </p>
        <PerformerBrowser performers={list} />
      </div>
    </>
  );
}
