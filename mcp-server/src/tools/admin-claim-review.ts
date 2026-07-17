/**
 * Claim-review MCP tools — OPE-67: list_claims / approve_claim / reject_claim.
 *
 * SOURCE OF TRUTH for the security semantics is the main app's
 * src/lib/claims/admin-review.ts (OPE-65). The MCP Worker and the main app do
 * NOT share runtime code, so the approve/reject logic is reimplemented here
 * field-for-field. Keep the two in lockstep. The canonical invariants:
 *   - NO SILENT TAKEOVER: approving an entity already claimed by a DIFFERENT
 *     user refuses (already_claimed_by_other) and touches nothing.
 *   - Guards: not_found / not_reviewable (status not PENDING|DISPUTED) /
 *     unsupported_entity (VENUE) / entity_missing.
 *   - Ownership transfer is guarded by claimed=false (idempotent).
 *   - Role grant is onConflictDoNothing.
 *   - Every decision writes an admin_actions audit row.
 *
 * NOTE: the main-app core also fires a best-effort decision email via the app's
 * queue producers. That producer is not available in the MCP runtime, so these
 * tools deliberately do NOT email the claimant — the admin acts on the queue
 * directly here. (The self-serve /admin/claims UI keeps the email path.)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { entityClaims, vendors, promoters, users, userRoles, adminActions } from "../schema.js";
import { jsonContent, decodeHtmlEntities } from "../helpers.js";
import { chunkedInArray } from "@takemetothefair/utils";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const LIST_LIMIT = 200;

type ReviewEntityType = "VENDOR" | "PROMOTER";

interface EntityLookup {
  ownerUserId: string | null;
  claimed: boolean;
  name: string;
  slug: string;
}

async function loadEntity(
  db: Db,
  entityType: ReviewEntityType,
  entityId: string
): Promise<EntityLookup | undefined> {
  if (entityType === "VENDOR") {
    const [row] = await db
      .select({
        ownerUserId: vendors.userId,
        claimed: vendors.claimed,
        name: vendors.businessName,
        slug: vendors.slug,
      })
      .from(vendors)
      .where(eq(vendors.id, entityId))
      .limit(1);
    if (!row) return undefined;
    return { ...row, slug: row.slug as unknown as string };
  }
  const [row] = await db
    .select({
      ownerUserId: promoters.userId,
      claimed: promoters.claimed,
      name: promoters.companyName,
      slug: promoters.slug,
    })
    .from(promoters)
    .where(eq(promoters.id, entityId))
    .limit(1);
  if (!row) return undefined;
  return { ...row, slug: row.slug as unknown as string };
}

export function registerClaimReviewTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  // ── list_claims ────────────────────────────────────────────────────────
  server.tool(
    "list_claims",
    "Read view over entity_claims for the claim-review queue (OPE-67). Optional filters: status (PENDING/APPROVED/REJECTED/DISPUTED) and entity_type (VENDOR/PROMOTER/VENUE). Rows are decorated with the entity name+slug and the claimant email, newest first. Capped at 200 (truncated flag set when more exist). Admin only.",
    {
      status: z
        .enum(["PENDING", "APPROVED", "REJECTED", "DISPUTED"])
        .optional()
        .describe("Filter by claim status. Omit for all statuses."),
      entity_type: z
        .enum(["VENDOR", "PROMOTER", "VENUE"])
        .optional()
        .describe("Filter by entity kind. Omit for all kinds."),
    },
    async ({ status, entity_type }) => {
      const filters = [];
      if (status) filters.push(eq(entityClaims.status, status));
      if (entity_type) filters.push(eq(entityClaims.entityType, entity_type));

      const rows = await db
        .select({
          id: entityClaims.id,
          entityType: entityClaims.entityType,
          entityId: entityClaims.entityId,
          userId: entityClaims.userId,
          method: entityClaims.method,
          status: entityClaims.status,
          evidence: entityClaims.evidence,
          createdAt: entityClaims.createdAt,
          decidedAt: entityClaims.decidedAt,
          decidedBy: entityClaims.decidedBy,
        })
        .from(entityClaims)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(entityClaims.createdAt))
        .limit(LIST_LIMIT + 1);

      const truncated = rows.length > LIST_LIMIT;
      const page = truncated ? rows.slice(0, LIST_LIMIT) : rows;

      // Decorate (VENDOR/PROMOTER only — VENUE has no lookup here).
      const vendorIds = [
        ...new Set(page.filter((r) => r.entityType === "VENDOR").map((r) => r.entityId)),
      ];
      const promoterIds = [
        ...new Set(page.filter((r) => r.entityType === "PROMOTER").map((r) => r.entityId)),
      ];
      const userIds = [...new Set(page.map((r) => r.userId))];

      // OPE-241 — chunked: LIST_LIMIT is 200, i.e. ABOVE D1's 100-bound-param
      // cap, so these decorate lookups are not "latent" — a claim queue with
      // >100 distinct vendors already throws "too many SQL variables" today.
      const vendorById = new Map<string, { name: string; slug: string }>();
      const vrows = await chunkedInArray(vendorIds, (batch) =>
        db
          .select({ id: vendors.id, name: vendors.businessName, slug: vendors.slug })
          .from(vendors)
          .where(inArray(vendors.id, batch))
      );
      for (const r of vrows)
        vendorById.set(r.id, { name: r.name, slug: r.slug as unknown as string });

      const promoterById = new Map<string, { name: string; slug: string }>();
      const prows = await chunkedInArray(promoterIds, (batch) =>
        db
          .select({ id: promoters.id, name: promoters.companyName, slug: promoters.slug })
          .from(promoters)
          .where(inArray(promoters.id, batch))
      );
      for (const r of prows)
        promoterById.set(r.id, { name: r.name, slug: r.slug as unknown as string });

      const userById = new Map<string, string>();
      const urows = await chunkedInArray(userIds, (batch) =>
        db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, batch))
      );
      for (const r of urows) userById.set(r.id, r.email);

      const claims = page.map((r) => {
        const entity =
          r.entityType === "VENDOR"
            ? vendorById.get(r.entityId)
            : r.entityType === "PROMOTER"
              ? promoterById.get(r.entityId)
              : undefined;
        return {
          id: r.id,
          entity_type: r.entityType,
          entity_id: r.entityId,
          entity_name: entity ? decodeHtmlEntities(entity.name) : null,
          entity_slug: entity?.slug ?? null,
          claimant_user_id: r.userId,
          claimant_email: userById.get(r.userId) ?? null,
          method: r.method,
          status: r.status,
          evidence: r.evidence,
          created_at: r.createdAt,
          decided_at: r.decidedAt,
          decided_by: r.decidedBy,
        };
      });

      return {
        content: [jsonContent({ count: claims.length, truncated, claims })],
      };
    }
  );

  // ── approve_claim ──────────────────────────────────────────────────────
  server.tool(
    "approve_claim",
    "Approve a PENDING/DISPUTED vendor or promoter claim by claim_id (OPE-67). Transfers ownership (guarded — never silently overrides a claim held by a DIFFERENT user), grants the entity role, marks the claim APPROVED, and writes an admin_actions audit row. Mirrors src/lib/claims/admin-review.ts. Admin only.",
    {
      claim_id: z.string().min(1).describe("entity_claims.id to approve."),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe("Optional note stored in the admin_actions audit payload."),
    },
    async ({ claim_id, reason }) => {
      const now = new Date();

      const [claim] = await db
        .select({
          id: entityClaims.id,
          entityType: entityClaims.entityType,
          entityId: entityClaims.entityId,
          userId: entityClaims.userId,
          method: entityClaims.method,
          status: entityClaims.status,
        })
        .from(entityClaims)
        .where(eq(entityClaims.id, claim_id))
        .limit(1);

      if (!claim) {
        return { content: [jsonContent({ ok: false, reason: "not_found" })], isError: true };
      }
      if (claim.status !== "PENDING" && claim.status !== "DISPUTED") {
        return {
          content: [jsonContent({ ok: false, reason: "not_reviewable", status: claim.status })],
          isError: true,
        };
      }
      if (claim.entityType !== "VENDOR" && claim.entityType !== "PROMOTER") {
        return {
          content: [jsonContent({ ok: false, reason: "unsupported_entity" })],
          isError: true,
        };
      }
      const entityType = claim.entityType;

      const entity = await loadEntity(db, entityType, claim.entityId);
      if (!entity) {
        return { content: [jsonContent({ ok: false, reason: "entity_missing" })], isError: true };
      }

      // NO SILENT TAKEOVER — a different owner is a genuine dispute.
      if (entity.claimed && entity.ownerUserId !== claim.userId) {
        return {
          content: [
            jsonContent({
              ok: false,
              reason: "already_claimed_by_other",
              entityType,
              entitySlug: entity.slug,
              entityName: decodeHtmlEntities(entity.name),
            }),
          ],
          isError: true,
        };
      }

      // Transfer ownership, guarded by claimed=false (idempotent).
      if (entityType === "VENDOR") {
        await db
          .update(vendors)
          .set({ userId: claim.userId, claimed: true, claimedAt: now, claimedBy: claim.userId })
          .where(and(eq(vendors.id, claim.entityId), eq(vendors.claimed, false)));
      } else {
        await db
          .update(promoters)
          .set({ userId: claim.userId, claimed: true, claimedAt: now, claimedBy: claim.userId })
          .where(and(eq(promoters.id, claim.entityId), eq(promoters.claimed, false)));
      }

      // Grant the entity role (idempotent).
      await db
        .insert(userRoles)
        .values({ userId: claim.userId, role: entityType, grantedAt: now, grantedBy: auth.userId })
        .onConflictDoNothing();

      // Mark APPROVED.
      await db
        .update(entityClaims)
        .set({ status: "APPROVED", decidedAt: now, decidedBy: auth.userId })
        .where(eq(entityClaims.id, claim.id));

      // Audit.
      await db.insert(adminActions).values({
        action:
          entityType === "VENDOR"
            ? "vendor.claim_admin_review_approve"
            : "promoter.claim_admin_review_approve",
        actorUserId: auth.userId,
        targetType: entityType.toLowerCase(),
        targetId: claim.entityId,
        payloadJson: JSON.stringify({
          via: "mcp:approve_claim",
          claimId: claim.id,
          method: claim.method,
          reason: reason ?? null,
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            ok: true,
            claimId: claim.id,
            entityType,
            entitySlug: entity.slug,
            entityName: decodeHtmlEntities(entity.name),
            grantedTo: claim.userId,
          }),
        ],
      };
    }
  );

  // ── reject_claim ───────────────────────────────────────────────────────
  server.tool(
    "reject_claim",
    "Reject a PENDING/DISPUTED vendor or promoter claim by claim_id (OPE-67). Marks the claim REJECTED (decidedAt/decidedBy) and writes an admin_actions audit row with the reason. Ownership is NEVER touched. Mirrors src/lib/claims/admin-review.ts. Admin only.",
    {
      claim_id: z.string().min(1).describe("entity_claims.id to reject."),
      reason: z
        .string()
        .min(1)
        .max(500)
        .describe("Why the claim is being rejected. Stored in the admin_actions audit payload."),
    },
    async ({ claim_id, reason }) => {
      const now = new Date();

      const [claim] = await db
        .select({
          id: entityClaims.id,
          entityType: entityClaims.entityType,
          entityId: entityClaims.entityId,
          userId: entityClaims.userId,
          status: entityClaims.status,
        })
        .from(entityClaims)
        .where(eq(entityClaims.id, claim_id))
        .limit(1);

      if (!claim) {
        return { content: [jsonContent({ ok: false, reason: "not_found" })], isError: true };
      }
      if (claim.status !== "PENDING" && claim.status !== "DISPUTED") {
        return {
          content: [jsonContent({ ok: false, reason: "not_reviewable", status: claim.status })],
          isError: true,
        };
      }
      if (claim.entityType !== "VENDOR" && claim.entityType !== "PROMOTER") {
        // VENUE has no claim funnel — treat as not reviewable (parity with approve).
        return {
          content: [jsonContent({ ok: false, reason: "not_reviewable" })],
          isError: true,
        };
      }
      const entityType = claim.entityType;

      // Mark REJECTED. Ownership untouched.
      await db
        .update(entityClaims)
        .set({ status: "REJECTED", decidedAt: now, decidedBy: auth.userId })
        .where(eq(entityClaims.id, claim.id));

      await db.insert(adminActions).values({
        action:
          entityType === "VENDOR"
            ? "vendor.claim_admin_review_reject"
            : "promoter.claim_admin_review_reject",
        actorUserId: auth.userId,
        targetType: entityType.toLowerCase(),
        targetId: claim.entityId,
        payloadJson: JSON.stringify({ via: "mcp:reject_claim", claimId: claim.id, reason }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            ok: true,
            claimId: claim.id,
            entityType,
            entityId: claim.entityId,
            rejectReason: reason,
          }),
        ],
      };
    }
  );
}
