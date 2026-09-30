/**
 * OPE-986 — make a near-duplicate self-registration VISIBLE.
 *
 * ── The case ────────────────────────────────────────────────────────────────
 * 2026-09-13, eight minutes apart, one person:
 *
 *   17:37  "Sansa Studio Creations"  sanzaart@gmail.com     (address missing an s)
 *   17:45  "Sanza Studio Creations"  sanzaarts@gmail.vom    (bounced)
 *
 * OPE-573's collision pre-flight compares SLUGS, and `sansa-studio-creations`
 * ≠ `sanza-studio-creations`, so the second signup minted a second account and
 * a second listing without a trace. Two later attempts reusing the second
 * spelling DID collide — against his own fresh listing — and were logged only
 * as "name collision". Nobody could see it was one person until he wrote in.
 *
 * ── Visibility only ─────────────────────────────────────────────────────────
 * No block, no merge. Two genuinely different makers can register similar
 * names in the same half hour, and a false block at signup costs a real person
 * their account. This writes one `warn` row to `error_logs` naming BOTH ids so
 * an operator can merge (merge_vendor) or leave it. Fail-soft: a registration
 * must never fail over an advisory check.
 *
 * Not a new execution path (OPE-246): it runs inside the existing register
 * request and writes nothing when there is no match, so there is no steady
 * evidence stream a heartbeat probe could watch.
 */
import { and, desc, eq, gte, ne } from "drizzle-orm";
import { levenshteinSimilarity } from "@takemetothefair/utils";
import { users, vendors } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

/** How far back a prior self-registration counts as "the same sitting". */
export const NEAR_DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
/** Normalized Levenshtein on business names. Sansa/Sanza Studio Creations = 0.95. */
export const BUSINESS_NAME_SIMILARITY_MIN = 0.8;
/** Normalized Levenshtein on email local parts. sanzaart/sanzaarts = 0.89. */
export const EMAIL_LOCAL_SIMILARITY_MIN = 0.75;
/** Upper bound on rows read — self-registrations per half hour are single digits. */
const MAX_RECENT = 50;

export type NearDuplicateReason = "similar_business_name" | "same_owner_name_similar_email";

export interface RegistrationFingerprint {
  businessName: string;
  ownerName: string | null;
  email: string | null;
}

function localPart(email: string | null): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return (at > 0 ? email.slice(0, at) : email).toLowerCase();
}

function sameName(a: string | null, b: string | null): boolean {
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return norm(a) !== "" && norm(a) === norm(b);
}

/** Why `other` looks like the same person as `candidate`. Empty = unrelated. */
export function nearDuplicateReasons(
  candidate: RegistrationFingerprint,
  other: RegistrationFingerprint
): NearDuplicateReason[] {
  const reasons: NearDuplicateReason[] = [];
  if (
    levenshteinSimilarity(
      candidate.businessName,
      other.businessName,
      BUSINESS_NAME_SIMILARITY_MIN
    ) >= BUSINESS_NAME_SIMILARITY_MIN
  ) {
    reasons.push("similar_business_name");
  }
  const a = localPart(candidate.email);
  const b = localPart(other.email);
  if (
    sameName(candidate.ownerName, other.ownerName) &&
    a !== "" &&
    b !== "" &&
    levenshteinSimilarity(a, b, EMAIL_LOCAL_SIMILARITY_MIN) >= EMAIL_LOCAL_SIMILARITY_MIN
  ) {
    reasons.push("same_owner_name_similar_email");
  }
  return reasons;
}

export interface NearDuplicateMatch {
  vendorId: string;
  userId: string;
  businessName: string;
  createdAt: string | null;
  reasons: NearDuplicateReason[];
}

/**
 * Compare a just-created self-registered vendor against the other
 * self-registrations of the last half hour, and log any look-alike.
 * Returns the matches (empty on none or on failure).
 */
export async function flagNearDuplicateVendorRegistration(
  db: Db,
  input: RegistrationFingerprint & { vendorId: string; userId: string; now?: Date }
): Promise<NearDuplicateMatch[]> {
  const now = input.now ?? new Date();
  try {
    const recent = await db
      .select({
        vendorId: vendors.id,
        userId: vendors.userId,
        businessName: vendors.businessName,
        createdAt: vendors.createdAt,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(vendors)
      .innerJoin(users, eq(users.id, vendors.userId))
      .where(
        and(
          gte(vendors.createdAt, new Date(now.getTime() - NEAR_DUPLICATE_WINDOW_MS)),
          ne(vendors.id, input.vendorId),
          // The shape the register route writes for a self-authored listing.
          // Ingested rows are unclaimed, so a scraper burst cannot crowd a real
          // signup out of the LIMIT.
          eq(vendors.claimed, true),
          eq(vendors.claimedBy, vendors.userId)
        )
      )
      .orderBy(desc(vendors.createdAt))
      .limit(MAX_RECENT);

    const matches: NearDuplicateMatch[] = [];
    for (const row of recent) {
      const reasons = nearDuplicateReasons(input, {
        businessName: row.businessName,
        ownerName: row.ownerName,
        email: row.ownerEmail,
      });
      if (reasons.length === 0) continue;
      matches.push({
        vendorId: row.vendorId,
        userId: row.userId,
        businessName: row.businessName,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
        reasons,
      });
    }

    if (matches.length > 0) {
      await logError(db, {
        level: "warn",
        message: "OPE-986 near-duplicate vendor registration — not merged, not blocked",
        source: "api/auth/register:near-duplicate",
        context: {
          vendorId: input.vendorId,
          userId: input.userId,
          businessName: input.businessName,
          matches,
        },
      });
    }
    return matches;
  } catch (err) {
    await logError(db, {
      level: "warn",
      message: "OPE-986 near-duplicate registration check failed",
      error: err,
      source: "api/auth/register:near-duplicate",
      context: { vendorId: input.vendorId },
    });
    return [];
  }
}
