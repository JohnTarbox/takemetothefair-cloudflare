export const dynamic = "force-dynamic";
/**
 * OPE-237 — the admin-triggered corroboration pass.
 *
 * ## Why this route exists
 *
 * `classifyDeclaredPresence` and `reassessClaimEvidence` both shipped with
 * PR #791 and, measured on 2026-08-20, **had zero callers outside their own
 * module**. `corroboration_detail` was NULL on all 35 evidence rows. The
 * corroboration half of the realness screen was built and never wired — the
 * shipped-but-never-executing class, in a file whose own docblock cites
 * OPE-246.
 *
 * Three separate hard-codes kept the dimension at `UNAVAILABLE`, and fixing any
 * one alone would have changed nothing:
 *
 *   1. the registration form collected no website  (fixed: the field is added)
 *   2. the register route passed `website: null`   (fixed: it passes the value)
 *   3. `recordClaimEvidence` called `assessRealness(args, "UNAVAILABLE")` and
 *      never invoked the classifier                (fixed: by THIS pass)
 *
 * ## Why a separate pass rather than inline at signup
 *
 * Corroboration is a network fetch against someone else's web server.
 * `recordClaimEvidence` runs inline in the registration request and is
 * deliberately network-free — a slow or hanging vendor site must never delay a
 * signup, and `rescoreEvidenceAfterVerification` makes the same choice for the
 * same reason ("a user-facing verification click must not block on someone
 * else's web server").
 *
 * So the row is written fast and pessimistic, and this pass resolves it later.
 * That is the design the existing docblock already described as "a separate,
 * admin-triggered pass"; it simply had no trigger.
 *
 * ## What it will NOT do
 *
 * Nothing here writes to the public vendor row. The declared website is used to
 * SCORE the claim, not to populate the listing — per the ticket's guardrail that
 * web-sourced data never auto-applies to a public profile. An unverified
 * registrant's URL going straight onto a live page is exactly what the realness
 * screen exists to catch, so it must not be the thing that publishes it.
 *
 * Auth: admin session OR X-Internal-Key (the MCP tool uses the latter).
 */
import { NextResponse } from "next/server";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendorClaimEvidence } from "@/lib/db/schema";
import { classifyDeclaredPresence, reassessClaimEvidence } from "@/lib/claims/claim-evidence";
import { fetchHtmlWithSsrfGuard } from "@takemetothefair/site-fetch";
import { logError } from "@/lib/logger";

/** Per-site budget. A vendor's slow server must not stall the whole pass. */
const FETCH_TIMEOUT_MS = 8000;
/** Default batch. Small because each row costs one outbound fetch. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

type PostBody = { limit?: unknown; vendor_id?: unknown };

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  let body: PostBody = {};
  try {
    body = (await request.json()) as PostBody;
  } catch {
    // Empty body is fine — the defaults are the common case.
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, typeof body.limit === "number" ? body.limit : DEFAULT_LIMIT)
  );
  const vendorId = typeof body.vendor_id === "string" ? body.vendor_id : null;

  const db = getCloudflareDb();

  // Eligible = has a declared site AND has not been corroborated yet. A row
  // already classified is left alone: re-fetching every run would turn an
  // operator action into a crawler.
  const where = vendorId
    ? eq(vendorClaimEvidence.vendorId, vendorId)
    : and(
        isNotNull(vendorClaimEvidence.declaredWebsite),
        ne(vendorClaimEvidence.declaredWebsite, ""),
        eq(vendorClaimEvidence.corroboration, "UNAVAILABLE")
      );

  const rows = await db
    .select({
      vendorId: vendorClaimEvidence.vendorId,
      userId: vendorClaimEvidence.userId,
      claimantName: vendorClaimEvidence.claimantName,
      claimantEmail: vendorClaimEvidence.claimantEmail,
      businessName: vendorClaimEvidence.businessName,
      declaredWebsite: vendorClaimEvidence.declaredWebsite,
      emailVerifiedAt: sql<number | null>`NULL`,
    })
    .from(vendorClaimEvidence)
    .where(where)
    .limit(limit);

  const results: Array<{
    vendor_id: string;
    website: string | null;
    corroboration: string;
    detail: string;
    score: number;
    band: string;
  }> = [];

  for (const row of rows) {
    // `claimant_email` is nullable on the table but is the key the verification
    // re-score joins on; a row without one cannot be re-scored coherently, so
    // skip rather than coerce to "" and score a blank address.
    if (!row.declaredWebsite || !row.claimantEmail) continue;
    const claimantEmail = row.claimantEmail;
    try {
      const verdict = await classifyDeclaredPresence(
        row.declaredWebsite,
        row.businessName,
        // SSRF-guarded, and that is not optional here: this URL comes from an
        // UNVERIFIED PUBLIC REGISTRANT, not from an operator. A stored
        // `http://169.254.169.254/…` would otherwise be fetched by our Worker
        // the moment an admin ran the pass — stored SSRF with a human trigger.
        //
        // The guard re-checks the host on every redirect hop, because a public
        // host can 3xx into an internal one and a single up-front check misses
        // it. Same pattern as /api/admin/upload-image-from-url.
        //
        // ⚠️ DNS rebinding remains a documented residual (the Workers runtime
        // exposes no resolved IP), accepted on the same grounds as the sibling
        // routes: Workers have no metadata service or internal HTTP network to
        // pivot into.
        async (url: string) => {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          try {
            const out = await fetchHtmlWithSsrfGuard(url, controller.signal);
            return out.ok
              ? { ok: true, html: out.html }
              : { ok: false, html: null, failReason: out.error };
          } finally {
            clearTimeout(t);
          }
        }
      );

      const { score, band } = await reassessClaimEvidence(db, {
        vendorId: row.vendorId,
        input: {
          claimantName: row.claimantName,
          businessName: row.businessName,
          email: claimantEmail,
          // Verification state is owned by rescoreEvidenceAfterVerification and
          // is re-derived there. Passing `false` here would silently un-award
          // the 25 verification points on every corroboration run — a pass
          // meant to IMPROVE a row must not be able to demote it on a
          // dimension it knows nothing about.
          emailVerified: await isEmailVerified(db, claimantEmail),
          website: row.declaredWebsite,
          description: null,
        },
        corroboration: verdict.corroboration,
        corroborationDetail: verdict.detail,
      });

      results.push({
        vendor_id: row.vendorId,
        website: row.declaredWebsite,
        corroboration: verdict.corroboration,
        detail: verdict.detail,
        score,
        band,
      });
    } catch (err) {
      await logError(db, {
        level: "warn",
        message: "OPE-237 corroboration pass failed for one row",
        error: err,
        source: "api/admin/claims/corroborate",
        context: { vendorId: row.vendorId, website: row.declaredWebsite },
      });
    }
  }

  return NextResponse.json({
    success: true,
    eligible: rows.length,
    corroborated: results.length,
    results,
    // Says WHY zero when zero. "No eligible rows" and "the pass is broken" look
    // identical from a bare count, which is the failure this ticket keeps
    // finding in other people's instruments.
    note:
      rows.length === 0
        ? "No eligible rows — every evidence row either has no declared website or is already corroborated."
        : `Corroborated ${results.length} of ${rows.length} eligible row(s).`,
  });
}

/** Is this address verified? Read from `users`, the same source the
 *  verification re-score uses, so the two passes cannot disagree. */
async function isEmailVerified(
  db: ReturnType<typeof getCloudflareDb>,
  email: string
): Promise<boolean> {
  const { users } = await import("@/lib/db/schema");
  const [u] = await db
    .select({ verified: users.emailVerified })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return Boolean(u?.verified);
}
