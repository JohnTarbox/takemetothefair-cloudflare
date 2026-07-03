/**
 * OPE-65 — /admin/claims review queue.
 *
 * Lists every PENDING / DISPUTED vendor + promoter claim (VENUE has no claim
 * funnel yet and is filtered out in the core query) so an admin can approve or
 * reject each with one click. Approving transfers ownership + grants the role +
 * emails the claimant; rejecting records the reason in the audit payload + email.
 *
 * Server component. Admin auth is enforced by src/app/admin/layout.tsx — not
 * re-guarded here. Renders a clean empty state when there are zero claims (an
 * empty collection must never throw — the OPE-58 crash class).
 */
import { getCloudflareDb } from "@/lib/cloudflare";
import { listReviewableClaims } from "@/lib/claims/admin-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClaimReviewActions } from "@/components/admin/ClaimReviewActions";

export const dynamic = "force-dynamic";

function entityBadgeClasses(entityType: string): string {
  return entityType === "VENDOR"
    ? "bg-info-soft text-navy-dark border-info-soft"
    : "bg-amber-50 text-amber-800 border-amber-200";
}

function statusBadgeClasses(status: string): string {
  return status === "DISPUTED"
    ? "bg-red-50 text-red-800 border-red-300"
    : "bg-muted text-muted-foreground border-border";
}

function listingHref(entityType: string, slug: string | null): string | null {
  if (!slug) return null;
  return entityType === "VENDOR" ? `/vendors/${slug}` : `/promoters/${slug}`;
}

export default async function AdminClaimsPage() {
  const claims = await listReviewableClaims(getCloudflareDb());

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Claim review queue</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pending and disputed claims filed against vendor and promoter listings. Approving
          transfers ownership to the claimant and grants them the role; rejecting leaves ownership
          untouched. Both notify the claimant by email.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="Awaiting review" value={claims.length} />
        <Stat label="Disputed" value={claims.filter((c) => c.status === "DISPUTED").length} />
        <Stat label="Pending" value={claims.filter((c) => c.status === "PENDING").length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Claims</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {claims.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No claims awaiting review. New pending or disputed claims will appear here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-muted border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">listing</th>
                    <th className="px-4 py-2 font-medium">claimant</th>
                    <th className="px-4 py-2 font-medium">method</th>
                    <th className="px-4 py-2 font-medium">status</th>
                    <th className="px-4 py-2 font-medium">evidence</th>
                    <th className="px-4 py-2 font-medium text-right">attempts</th>
                    <th className="px-4 py-2 font-medium">filed</th>
                    <th className="px-4 py-2 font-medium">actions</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c) => {
                    const href = listingHref(c.entityType, c.entitySlug);
                    return (
                      <tr key={c.id} className="border-b border-border align-top hover:bg-muted">
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium border mb-1 ${entityBadgeClasses(
                              c.entityType
                            )}`}
                          >
                            {c.entityType}
                          </span>
                          <div className="font-medium text-foreground">
                            {href ? (
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                className="text-royal hover:underline"
                              >
                                {c.entityName ?? c.entityId}
                              </a>
                            ) : (
                              (c.entityName ?? c.entityId)
                            )}
                          </div>
                          {c.entitySlug && (
                            <div className="text-xs text-muted-foreground font-mono">
                              {c.entitySlug}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          <div className="font-mono break-all">{c.claimantEmail ?? "—"}</div>
                          {c.claimantName && <div>{c.claimantName}</div>}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
                          {c.method}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium border ${statusBadgeClasses(
                              c.status
                            )}`}
                          >
                            {c.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground max-w-[220px]">
                          {c.evidence ? (
                            <span className="break-words whitespace-pre-wrap">{c.evidence}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-foreground">
                          {c.attemptCount}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {c.createdAt ? c.createdAt.toISOString().slice(0, 10) : "—"}
                        </td>
                        <td className="px-4 py-3 min-w-[200px]">
                          <ClaimReviewActions claimId={c.id} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums mt-1 text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}
