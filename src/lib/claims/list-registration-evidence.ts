/**
 * OPE-237 — read side of the vendor registration realness screen.
 *
 * Feeds /admin/claims. Ordered worst-first (SUSPECT, then NEEDS_REVIEW, then
 * LIKELY_REAL) because the queue's job is to put the thing a human should look
 * at hardest at the top — a chronological list buries a spam signup under a
 * week of clean ones.
 */
import { desc, eq, sql } from "drizzle-orm";
import { vendorClaimEvidence, vendors } from "@/lib/db/schema";
import type { Db } from "@/lib/analytics-overview/shared";
import type { CorroborationClass, RealnessBand, SpamFlag } from "./realness";

export interface RegistrationEvidenceRow {
  vendorId: string;
  vendorSlug: string | null;
  businessName: string;
  claimantName: string | null;
  claimantEmail: string | null;
  declaredWebsite: string | null;
  band: RealnessBand;
  score: number;
  corroboration: CorroborationClass;
  corroborationDetail: string | null;
  reasons: string[];
  spamFlags: SpamFlag[];
  createdAt: Date | null;
  assessedAt: Date | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A malformed blob must not blank the whole queue — degrade this one field.
    return fallback;
  }
}

/**
 * Recent registration screens, worst band first.
 *
 * Never throws on an empty table (the OPE-58 empty-collection crash class) and
 * never throws on a malformed JSON column — a reviewer seeing a partial row is
 * strictly better than a 500 on the whole queue.
 */
export async function listRegistrationEvidence(
  db: Db,
  limit = 50
): Promise<RegistrationEvidenceRow[]> {
  const rows = await db
    .select({
      vendorId: vendorClaimEvidence.vendorId,
      vendorSlug: vendors.slug,
      businessName: vendorClaimEvidence.businessName,
      claimantName: vendorClaimEvidence.claimantName,
      claimantEmail: vendorClaimEvidence.claimantEmail,
      declaredWebsite: vendorClaimEvidence.declaredWebsite,
      band: vendorClaimEvidence.band,
      score: vendorClaimEvidence.score,
      corroboration: vendorClaimEvidence.corroboration,
      corroborationDetail: vendorClaimEvidence.corroborationDetail,
      reasons: vendorClaimEvidence.reasons,
      signals: vendorClaimEvidence.signals,
      createdAt: vendorClaimEvidence.createdAt,
      assessedAt: vendorClaimEvidence.assessedAt,
    })
    .from(vendorClaimEvidence)
    .leftJoin(vendors, eq(vendors.id, vendorClaimEvidence.vendorId))
    .orderBy(
      // Worst first. CASE keeps the ordering in SQL rather than pulling the
      // whole table into memory to sort it.
      sql`CASE ${vendorClaimEvidence.band}
            WHEN 'SUSPECT' THEN 0
            WHEN 'NEEDS_REVIEW' THEN 1
            ELSE 2 END`,
      desc(vendorClaimEvidence.createdAt)
    )
    .limit(limit);

  return rows.map((r) => ({
    vendorId: r.vendorId,
    vendorSlug: r.vendorSlug ?? null,
    businessName: r.businessName,
    claimantName: r.claimantName,
    claimantEmail: r.claimantEmail,
    declaredWebsite: r.declaredWebsite,
    band: (r.band ?? "NEEDS_REVIEW") as RealnessBand,
    score: r.score ?? 0,
    corroboration: (r.corroboration ?? "UNAVAILABLE") as CorroborationClass,
    corroborationDetail: r.corroborationDetail,
    reasons: parseJson<string[]>(r.reasons, []),
    spamFlags: parseJson<{ spamFlags?: SpamFlag[] }>(r.signals, {}).spamFlags ?? [],
    createdAt: r.createdAt ?? null,
    assessedAt: r.assessedAt ?? null,
  }));
}
