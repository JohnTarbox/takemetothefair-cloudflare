/**
 * OPE-649 — read a vendor the way a support diagnosis needs to.
 *
 * Events had an admin reader (`get_event_details_admin`, OPE-500). Vendors did
 * not, and on 2026-08-30 that gap meant a customer-support diagnosis was only
 * possible for an operator holding direct D1 access.
 *
 * A vendor wrote in: *"every time we make a correction and save our vendor
 * profile, nothing updates and the account displays none of our information."*
 * Answering that required knowing whether her writes were landing. Every fact
 * that settled it came from raw D1 and none from a tool:
 *
 *   user_id, created_at        the row is hers, from her own signup
 *   claimed, claimed_at/_by    she owns it — not an enrichment row she found
 *   enrichment_source          self-authored, not scraped
 *   updated_at                 HER LAST SAVE LANDED 18 MINUTES BEFORE SHE WROTE
 *   completeness_score         the profile is genuinely complete
 *   deleted_at                 not a tombstone
 *
 * `get_vendor_details` returns the public shape. It is useful for reading a
 * listing and useless for "did this person's edit save?" — and without D1 the
 * honest answer would have been "your page looks fine to me", which is worthless
 * to someone convinced the site ate their work. (It had not: her writes were
 * landing and the real defect was diacritic-blind search, OPE-647.)
 *
 * ── A separate tool, not a widened one ──────────────────────────────────────
 * `get_vendor_details` feeds public surfaces, and `vendors.contact_email`
 * already renders publicly as a mailto. Nothing here may reach that shape. Same
 * reasoning as OPE-500's: the public registrar is wired before authentication
 * exists on the legacy transport, so a flag on the public tool would have no
 * role to check against.
 *
 * ── The OPE-534 cross-check (scope 5) ───────────────────────────────────────
 * `update_vendor` can write `address`, `zip` and `social_links`; the public
 * reader shows none of the three. That is OPE-534's defect in vendor form — a
 * writer destroying fields no reader could show first — and it is closed here
 * rather than filed, because this reader returns all three.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { unsafeSlug, isPlaceholderEmail } from "@takemetothefair/utils";
import { vendors, users, entityClaims, eventVendors } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/**
 * Every timestamp twice: the stored integer and a human-readable ISO string.
 *
 * OPE-649 scope 3, and it is not a convenience. These columns are unix epoch
 * SECONDS, and comparing one to `date('now')` returns zero rows with no error —
 * a trap that has already produced a false finding on this project (and again
 * on 2026-08-30, where a sweep read as "no affected rows" because
 * `strftime('%s',…)` returns TEXT and SQLite sorts every integer below every
 * text value). Showing both makes the unit impossible to misread.
 */
function stamp(d: Date | null | undefined): { epoch: number | null; iso: string | null } {
  if (!d) return { epoch: null, iso: null };
  const ms = d instanceof Date ? d.getTime() : Number(d) * 1000;
  if (!Number.isFinite(ms)) return { epoch: null, iso: null };
  return { epoch: Math.floor(ms / 1000), iso: new Date(ms).toISOString() };
}

export function registerAdminVendorReadTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_vendor_details_admin",
    "OPE-649 — read ONE vendor in full by slug OR id, including every ownership, claim, " +
      "provenance and lifecycle column that get_vendor_details omits: user_id, claimed/claimed_at/claimed_by, " +
      "created_at, updated_at, deleted_at, enrichment_source, enrichment_attempted_at, completeness_score, " +
      "domain_hijacked, can_self_confirm, enhanced_profile + window, featured_priority, view_count, " +
      "verified_pro + who/when, redirect_to_vendor_id, alias_of_vendor_id, and the RAW logo_url / social_links / " +
      "gallery_images. Also decorates with the owning user's email + email_verified, whether an entity_claims row " +
      "exists (it usually does NOT — the live claim path writes vendors.claimed only, OPE-236), and the linked-event count. " +
      "USE THIS to answer 'did this person's edit actually save?' — `updated_at` is the field that settles it, and the " +
      "public reader does not return it. Every timestamp is given as BOTH an epoch integer and an ISO string, because " +
      "these columns are epoch SECONDS and comparing one to date('now') silently returns nothing. " +
      "Read-only. Admin only. Does NOT change get_vendor_details, which feeds public surfaces.",
    {
      slug: z.string().optional().describe("Vendor slug, e.g. 'aehko'."),
      vendor_id: z.string().optional().describe("Vendor UUID."),
    },
    async (params) => {
      if (!params.slug && !params.vendor_id) {
        return {
          content: [jsonContent({ error: "slug_or_vendor_id_required" })],
          isError: true,
        };
      }

      const [row] = await db
        .select({
          vendor: vendors,
          ownerEmail: users.email,
          ownerEmailVerified: users.emailVerified,
          ownerRole: users.role,
          ownerOrigin: users.origin,
        })
        .from(vendors)
        // LEFT, though `vendors.user_id` is NOT NULL with an FK: D1 does not
        // enforce foreign keys unless PRAGMA foreign_keys is on, so an INNER
        // join here could return ZERO ROWS for a vendor whose user row went
        // missing — turning the exact corruption this reader exists to find
        // into "vendor_not_found".
        .leftJoin(users, eq(users.id, vendors.userId))
        .where(
          params.vendor_id
            ? eq(vendors.id, params.vendor_id)
            : eq(vendors.slug, unsafeSlug(params.slug!))
        )
        .limit(1);

      if (!row) {
        return {
          content: [jsonContent({ error: "vendor_not_found", ...params })],
          isError: true,
        };
      }

      const v = row.vendor;

      const [claimRow] = await db
        .select({
          n: sql<number>`count(*)`,
          latest: sql<string | null>`max(${entityClaims.status})`,
        })
        .from(entityClaims)
        .where(and(eq(entityClaims.entityType, "VENDOR"), eq(entityClaims.entityId, v.id)));

      const [eventCount] = await db
        .select({ n: sql<number>`count(*)` })
        .from(eventVendors)
        .where(eq(eventVendors.vendorId, v.id));

      return {
        content: [
          jsonContent({
            id: v.id,
            slug: v.slug,
            business_name: v.businessName,
            display_name: v.displayName,
            description: v.description,
            vendor_type: v.vendorType,
            products: v.products,
            website: v.website,

            // ── ownership ──────────────────────────────────────────────────
            // The first question a support diagnosis asks, and the one the
            // public reader cannot answer.
            user_id: v.userId,
            owner_email: row.ownerEmail ?? null,
            owner_email_verified: stamp(row.ownerEmailVerified as Date | null),
            owner_role: row.ownerRole ?? null,
            owner_origin: row.ownerOrigin ?? null,
            /**
             * Is the "owner" a real person, or an ingestion placeholder?
             *
             * `vendors.user_id` is NOT NULL, so every vendor has an owning user
             * and the mere presence of one proves nothing. 6,620 of 6,741 users
             * are `pending+<slug>@meetmeatthefair.com` rows minted by ingestion
             * (OPE-292/293) — synthetic, never authenticatable. Reading
             * `user_id IS NOT NULL` as "someone owns this" is wrong ~98% of the
             * time.
             *
             * BOTH predicates, deliberately. placeholder-account.ts's own
             * header says they fail in opposite directions — the address shape
             * cannot catch an ingestion path that mints a differently-formed
             * address, and the `origin` column cannot catch a writer that
             * forgot to stamp it (which has already happened once). That file
             * notes the two-check version needs the resolved row in hand and so
             * could not live in the auth guards. This reader HAS the row.
             *
             * When they disagree, `agree: false` is the finding: it means one
             * of the two is wrong about this row, and which one tells you
             * whether an ingestion path or a stamp is at fault.
             */
            owner_is_placeholder: {
              by_email_shape: isPlaceholderEmail(row.ownerEmail),
              by_origin_column: row.ownerOrigin === "ingestion",
              agree: isPlaceholderEmail(row.ownerEmail) === (row.ownerOrigin === "ingestion"),
            },

            // ── claim ──────────────────────────────────────────────────────
            claimed: v.claimed,
            claimed_at: stamp(v.claimedAt),
            claimed_by: v.claimedBy,
            // OPE-236 — the live claim path writes vendors.claimed ONLY, so this
            // is normally 0 even for a genuinely claimed vendor. A zero here is
            // NOT evidence the claim is fake.
            entity_claims_rows: Number(claimRow?.n ?? 0),
            entity_claims_latest_status: claimRow?.latest ?? null,

            // ── provenance + lifecycle ─────────────────────────────────────
            enrichment_source: v.enrichmentSource,
            enrichment_attempted_at: stamp(v.enrichmentAttemptedAt),
            completeness_score: v.completenessScore,
            domain_hijacked: v.domainHijacked,
            can_self_confirm: v.canSelfConfirm,
            created_at: stamp(v.createdAt),
            // THE field that settles "did my edit save?".
            updated_at: stamp(v.updatedAt),
            deleted_at: stamp(v.deletedAt),

            // ── tier + placement ───────────────────────────────────────────
            verified: v.verified,
            verified_pro: v.verifiedPro,
            verified_pro_at: stamp(v.verifiedProAt),
            verified_pro_by: v.verifiedProBy,
            enhanced_profile: v.enhancedProfile,
            enhanced_profile_started_at: stamp(v.enhancedProfileStartedAt),
            enhanced_profile_expires_at: stamp(v.enhancedProfileExpiresAt),
            featured_priority: v.featuredPriority,
            view_count: v.viewCount,
            commercial: v.commercial,

            // ── raw media/contact, unrendered ──────────────────────────────
            // RAW on purpose: OPE-524's defect was a logo_url holding a website
            // and a display_name holding a URL. A reader that prettifies these
            // hides exactly the shape you are looking for.
            logo_url: v.logoUrl,
            social_links: v.socialLinks,
            gallery_images: v.galleryImages,
            image_focal_x: v.imageFocalX,
            image_focal_y: v.imageFocalY,
            contact_name: v.contactName,
            contact_email: v.contactEmail,
            contact_phone: v.contactPhone,

            // OPE-534 cross-check: update_vendor writes these three and the
            // public reader shows none of them.
            address: v.address,
            city: v.city,
            state: v.state,
            zip: v.zip,
            latitude: v.latitude,
            longitude: v.longitude,

            // ── relationships ──────────────────────────────────────────────
            role: v.role,
            brand_parent_vendor_id: v.brandParentVendorId,
            operator_parent_vendor_id: v.operatorParentVendorId,
            alias_of_vendor_id: v.aliasOfVendorId,
            redirect_to_vendor_id: v.redirectToVendorId,
            relationship_type: v.relationshipType,
            default_child_display: v.defaultChildDisplay,
            display_override_permitted: v.displayOverridePermitted,
            display_mode: v.displayMode,

            linked_event_count: Number(eventCount?.n ?? 0),
          }),
        ],
      };
    }
  );
}
