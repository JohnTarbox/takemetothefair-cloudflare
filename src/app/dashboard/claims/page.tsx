import { redirect } from "next/navigation";
import Link from "next/link";
import { FileCheck2 } from "lucide-react";
import { desc, eq, inArray } from "drizzle-orm";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { entityClaims, vendors, promoters } from "@/lib/db/schema";
import { decodeHtmlEntities } from "@/lib/utils";

export const dynamic = "force-dynamic";

type DisplayStatus = "Pending" | "Approved" | "Rejected" | "Disputed" | "Needs evidence";

const STATUS_STYLES: Record<DisplayStatus, string> = {
  Approved: "bg-sage-100 text-sage-800",
  Pending: "bg-amber-light text-amber-dark",
  "Needs evidence": "bg-amber-light text-amber-dark",
  Rejected: "bg-stone-200 text-stone-700",
  Disputed: "bg-terracotta-light text-terracotta",
};

interface ClaimRow {
  id: string;
  entityType: "VENDOR" | "PROMOTER" | "VENUE";
  entityName: string | null;
  entitySlug: string | null;
  status: DisplayStatus;
  createdAt: Date | null;
}

function displayStatus(status: string, method: string): DisplayStatus {
  if (status === "APPROVED") return "Approved";
  if (status === "REJECTED") return "Rejected";
  if (status === "DISPUTED") return "Disputed";
  // PENDING → distinguish the evidence rung so the user knows action is on them.
  return method === "EVIDENCE" ? "Needs evidence" : "Pending";
}

async function getUserClaims(userId: string): Promise<ClaimRow[]> {
  const db = getCloudflareDb();
  const claims = await db
    .select({
      id: entityClaims.id,
      entityType: entityClaims.entityType,
      entityId: entityClaims.entityId,
      method: entityClaims.method,
      status: entityClaims.status,
      createdAt: entityClaims.createdAt,
    })
    .from(entityClaims)
    .where(eq(entityClaims.userId, userId))
    .orderBy(desc(entityClaims.createdAt));

  if (claims.length === 0) return [];

  const vendorIds = [
    ...new Set(claims.filter((c) => c.entityType === "VENDOR").map((c) => c.entityId)),
  ];
  const promoterIds = [
    ...new Set(claims.filter((c) => c.entityType === "PROMOTER").map((c) => c.entityId)),
  ];

  const vendorById = new Map<string, { name: string; slug: string }>();
  if (vendorIds.length > 0) {
    const rows = await db
      .select({ id: vendors.id, name: vendors.businessName, slug: vendors.slug })
      .from(vendors)
      .where(inArray(vendors.id, vendorIds));
    for (const r of rows) vendorById.set(r.id, { name: r.name, slug: r.slug as unknown as string });
  }
  const promoterById = new Map<string, { name: string; slug: string }>();
  if (promoterIds.length > 0) {
    const rows = await db
      .select({ id: promoters.id, name: promoters.companyName, slug: promoters.slug })
      .from(promoters)
      .where(inArray(promoters.id, promoterIds));
    for (const r of rows)
      promoterById.set(r.id, { name: r.name, slug: r.slug as unknown as string });
  }

  return claims.map((c) => {
    const entity =
      c.entityType === "VENDOR"
        ? vendorById.get(c.entityId)
        : c.entityType === "PROMOTER"
          ? promoterById.get(c.entityId)
          : undefined;
    return {
      id: c.id,
      entityType: c.entityType,
      entityName: entity ? decodeHtmlEntities(entity.name) : null,
      entitySlug: entity?.slug ?? null,
      status: displayStatus(c.status, c.method),
      createdAt: c.createdAt,
    };
  });
}

function publicHref(row: ClaimRow): string | null {
  if (!row.entitySlug) return null;
  if (row.entityType === "VENDOR") return `/vendors/${row.entitySlug}`;
  if (row.entityType === "PROMOTER") return `/promoters/${row.entitySlug}`;
  return null;
}

export default async function DashboardClaimsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login?callbackUrl=/dashboard/claims");
  }

  const claims = await getUserClaims(session.user.id);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">My claims</h1>
        <p className="mt-1 text-muted-foreground">
          Listings you&apos;ve claimed or requested to claim.
        </p>
      </div>

      {claims.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-stone-100">
              <FileCheck2 className="h-6 w-6 text-navy" aria-hidden />
            </div>
            <h2 className="font-medium text-foreground">No claims yet</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Found your business or organization already listed? Claim it for free to manage its
              public page.
            </p>
            <Link href="/vendors">
              <Button variant="outline" size="sm">
                Browse vendors
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-foreground">
              {claims.length} claim{claims.length === 1 ? "" : "s"}
            </h2>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {claims.map((c) => {
                const href = publicHref(c);
                return (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {href ? (
                          <Link href={href} className="hover:underline">
                            {c.entityName ?? "Unknown listing"}
                          </Link>
                        ) : (
                          (c.entityName ?? "Unknown listing")
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {c.entityType.toLowerCase()}
                        {c.createdAt ? ` · ${c.createdAt.toLocaleDateString()}` : ""}
                      </p>
                    </div>
                    <span
                      className={`inline-flex flex-shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[c.status]}`}
                    >
                      {c.status}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
