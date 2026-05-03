/**
 * Public promoters index — minimal alphabetical listing. Created in round-6
 * alongside the per-promoter pages so the breadcrumb on /promoters/[slug]
 * isn't a dead link.
 *
 * Filtering UI (state, verified-only, etc.) deferred — current promoter
 * count is small enough that a single alpha grid is readable. Revisit when
 * the catalog crosses ~50.
 */

import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ShieldCheck } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const runtime = "edge";
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Event Promoters | Meet Me at the Fair",
  description:
    "Browse fair and festival promoters across New England — the organizations behind the events.",
  alternates: { canonical: "https://meetmeatthefair.com/promoters" },
  openGraph: {
    title: "Event Promoters | Meet Me at the Fair",
    description:
      "Browse fair and festival promoters across New England — the organizations behind the events.",
    url: "https://meetmeatthefair.com/promoters",
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Event Promoters",
      },
    ],
  },
};

async function getPromoters() {
  const db = getCloudflareDb();
  try {
    return await db.select().from(promoters).orderBy(asc(promoters.companyName));
  } catch (e) {
    await logError(db, {
      message: "Error listing promoters",
      error: e,
      source: "app/promoters/page.tsx:getPromoters",
    });
    return [];
  }
}

export default async function PromotersIndex() {
  const list = await getPromoters();

  return (
    <>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Promoters", url: "https://meetmeatthefair.com/promoters" },
        ]}
      />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-2">Event Promoters</h1>
        <p className="text-gray-600 mb-8">
          The organizations behind the fairs, festivals, and markets you see on this site.
        </p>

        {list.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-gray-500">
              No promoters published yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {list.map((p) => (
              <Link
                key={p.id}
                href={`/promoters/${p.slug}`}
                className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 hover:shadow-sm transition"
              >
                <div className="flex items-start gap-3">
                  {p.logoUrl ? (
                    <div className="w-12 h-12 rounded-md overflow-hidden bg-gray-50 border border-gray-200 relative shrink-0">
                      <Image
                        src={p.logoUrl}
                        alt={`${p.companyName} logo`}
                        fill
                        sizes="48px"
                        className="object-contain"
                      />
                    </div>
                  ) : (
                    <div className="w-12 h-12 rounded-md bg-gray-100 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 flex items-center gap-1 flex-wrap">
                      <span className="truncate">{p.companyName}</span>
                      {p.verified && (
                        <Badge variant="info" className="text-xs">
                          <ShieldCheck className="w-3 h-3 mr-1 inline" />
                          Verified
                        </Badge>
                      )}
                    </p>
                    {(p.city || p.state) && (
                      <p className="text-sm text-gray-500 truncate">
                        {[p.city, p.state].filter(Boolean).join(", ")}
                      </p>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
