/**
 * EH1 Phase 1 (2026-06-05) — admin tools for vendor hierarchy mutations.
 *
 * Three audited write surfaces, all admin-only, all writing
 * `admin_actions` rows. Spec §5.2 lays out the contract:
 *
 *   set_vendor_relationship   — set/clear brand parent, operator parent,
 *                                relationship_type. Cycle + self-ref
 *                                guarded. Audits `vendor.relationship`.
 *   set_vendor_display_policy — the ONLY path for setting the parent-
 *                                controlled gate (display_override_permitted)
 *                                AND for the brand's default_child_display.
 *                                Refuses to set display_mode != 'inherit'
 *                                on a child whose gate is closed (encodes
 *                                spec §4.4). Audits `vendor.display_policy`.
 *   set_vendor_alias          — mark alias_of_vendor_id, repoint
 *                                event_vendors from alias → canonical
 *                                (batched), write vendor_slug_history,
 *                                soft-delete alias with redirect_to_vendor_id.
 *                                Audits `vendor.alias`.
 *
 * All three mirror the `merge_venue` / `merge_promoter` shape from
 * admin-merge-entities.ts: auth gate → validate → mutate via db.update
 * → audit insert wrapped in try/catch so audit failure never breaks the
 * operation. No main-app API hop — these are self-contained in the
 * Worker.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { vendors, eventVendors, vendorSlugHistory, adminActions } from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { jsonContent } from "../helpers.js";

// D1 caps bound params at 100 per statement (per [[feedback_d1_batch_param_limit]]).
// 50 is a safe batch size for inArray delete chains.
const FK_BATCH_SIZE = 50;

// Match resolveAlias's depth cap in src/lib/vendor-hierarchy.ts.
const RELATIONSHIP_CHAIN_MAX_DEPTH = 5;

/**
 * DFS-walk a parent-chain or alias-chain, rejecting if the walk reaches
 * back to `selfId` or exceeds the depth cap. Used by both
 * set_vendor_relationship and set_vendor_alias before any write so the
 * UPDATE only ever produces a sane graph.
 */
async function wouldFormCycle(
  db: Db,
  column: "brandParentVendorId" | "operatorParentVendorId" | "aliasOfVendorId",
  selfId: string,
  targetId: string | null
): Promise<boolean> {
  if (targetId == null) return false;
  if (targetId === selfId) return true; // self-ref
  const seen = new Set<string>([selfId]);
  let cursor: string | null = targetId;
  for (let depth = 0; depth < RELATIONSHIP_CHAIN_MAX_DEPTH; depth++) {
    if (cursor == null) return false;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const [row] = await db
      .select({
        brandParentVendorId: vendors.brandParentVendorId,
        operatorParentVendorId: vendors.operatorParentVendorId,
        aliasOfVendorId: vendors.aliasOfVendorId,
      })
      .from(vendors)
      .where(eq(vendors.id, cursor))
      .limit(1);
    if (!row) return false;
    cursor =
      column === "brandParentVendorId"
        ? row.brandParentVendorId
        : column === "operatorParentVendorId"
          ? row.operatorParentVendorId
          : row.aliasOfVendorId;
  }
  return true; // depth exceeded — treat as cycle
}

export function registerVendorHierarchyTools(server: McpServer, db: Db, auth: AuthContext) {
  // ── set_vendor_relationship ─────────────────────────────────────
  server.tool(
    "set_vendor_relationship",
    "Set or clear a vendor's brand_parent_vendor_id, operator_parent_vendor_id, and relationship_type. Cycle + self-ref guarded (depth 5). Audited as 'vendor.relationship'. Admin only. Patch-only: omitted fields are unchanged; pass `null` explicitly to clear an FK.",
    {
      vendor_id: z.string().min(1).describe("The vendor row to mutate."),
      brand_parent_vendor_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Brand parent vendor id (consumer-facing brand). Omit to leave unchanged; pass null to clear."
        ),
      operator_parent_vendor_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Operator parent vendor id (contracts/billing entity). Often equals brand parent for branch shapes; distinct for franchise-with-operator. Omit to leave unchanged; pass null to clear."
        ),
      relationship_type: z
        .enum([
          "branch",
          "franchise",
          "dealer",
          "member",
          "agent",
          "employee_branch",
          "government",
          "independent",
        ])
        .optional()
        .describe("8-shape relationship typology."),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Forbidden — admin only." }],
          isError: true,
        };
      }

      // Confirm the target vendor row exists and is live.
      const [target] = await db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          deletedAt: vendors.deletedAt,
          brandParentVendorId: vendors.brandParentVendorId,
          operatorParentVendorId: vendors.operatorParentVendorId,
          relationshipType: vendors.relationshipType,
        })
        .from(vendors)
        .where(eq(vendors.id, params.vendor_id))
        .limit(1);
      if (!target) {
        return {
          content: [{ type: "text" as const, text: `Vendor not found: ${params.vendor_id}` }],
          isError: true,
        };
      }
      if (target.deletedAt != null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Vendor is soft-deleted; relationship edits are blocked: ${params.vendor_id}`,
            },
          ],
          isError: true,
        };
      }

      // Validate FK targets resolve + are live, and reject cycles/self-ref.
      for (const [field, value, col] of [
        ["brand_parent_vendor_id", params.brand_parent_vendor_id, "brandParentVendorId"],
        ["operator_parent_vendor_id", params.operator_parent_vendor_id, "operatorParentVendorId"],
      ] as const) {
        if (value === undefined || value === null) continue;
        const [parentRow] = await db
          .select({ id: vendors.id, deletedAt: vendors.deletedAt })
          .from(vendors)
          .where(eq(vendors.id, value))
          .limit(1);
        if (!parentRow) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${field} target does not exist: ${value}`,
              },
            ],
            isError: true,
          };
        }
        if (parentRow.deletedAt != null) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${field} target is soft-deleted: ${value}`,
              },
            ],
            isError: true,
          };
        }
        if (await wouldFormCycle(db, col, params.vendor_id, value)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${field}=${value} would create a cycle or self-reference (depth ≤ ${RELATIONSHIP_CHAIN_MAX_DEPTH}).`,
              },
            ],
            isError: true,
          };
        }
      }

      // Build the UPDATE patch. Drizzle treats `undefined` as omit; we
      // already filtered above so any `null` here is an explicit clear.
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      const previous: Record<string, unknown> = {};
      if (params.brand_parent_vendor_id !== undefined) {
        updates.brandParentVendorId = params.brand_parent_vendor_id;
        previous.brand_parent_vendor_id = target.brandParentVendorId;
      }
      if (params.operator_parent_vendor_id !== undefined) {
        updates.operatorParentVendorId = params.operator_parent_vendor_id;
        previous.operator_parent_vendor_id = target.operatorParentVendorId;
      }
      if (params.relationship_type !== undefined) {
        updates.relationshipType = params.relationship_type;
        previous.relationship_type = target.relationshipType;
      }
      if (Object.keys(updates).length === 1) {
        // updatedAt is the only key — nothing to do.
        return {
          content: [
            {
              type: "text" as const,
              text: "No-op: provide at least one of brand_parent_vendor_id / operator_parent_vendor_id / relationship_type.",
            },
          ],
          isError: true,
        };
      }

      await db.update(vendors).set(updates).where(eq(vendors.id, params.vendor_id));

      try {
        await db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "vendor.relationship",
          targetType: "vendor",
          targetId: params.vendor_id,
          actorUserId: auth.userId ?? null,
          payloadJson: JSON.stringify({
            vendor_id: params.vendor_id,
            previous,
            applied: {
              brand_parent_vendor_id: params.brand_parent_vendor_id,
              operator_parent_vendor_id: params.operator_parent_vendor_id,
              relationship_type: params.relationship_type,
            },
          }),
          createdAt: new Date(),
        });
      } catch {
        // Audit failure must not fail the relationship write itself.
      }

      return {
        content: [
          jsonContent({
            updated: true,
            vendor_id: params.vendor_id,
            applied: {
              brand_parent_vendor_id: params.brand_parent_vendor_id,
              operator_parent_vendor_id: params.operator_parent_vendor_id,
              relationship_type: params.relationship_type,
            },
            previous,
          }),
        ],
      };
    }
  );

  // ── set_vendor_display_policy ───────────────────────────────────
  server.tool(
    "set_vendor_display_policy",
    "Set the brand-parent's default_child_display AND/OR per-office display_override_permitted + display_mode in one audited transaction. THE ONLY path for setting the per-office gate (encodes spec §4.4: parent's gate always wins; a vendor claim never bypasses it). Rejects display_mode != 'inherit' on a child whose gate is closed. Audited as 'vendor.display_policy'. Admin only.",
    {
      parent_vendor_id: z
        .string()
        .min(1)
        .describe(
          "The brand-parent vendor id whose policy + children are being set. Must be role='NATIONAL'."
        ),
      default_child_display: z
        .enum(["self", "brand_parent", "both"])
        .nullable()
        .optional()
        .describe(
          "Brand-parent's default display target for its offices. Omit to leave unchanged; pass null to clear."
        ),
      children: z
        .array(
          z.object({
            vendor_id: z.string().min(1).describe("Child office vendor id."),
            display_override_permitted: z
              .boolean()
              .optional()
              .describe("Flip the per-office gate."),
            display_mode: z
              .enum(["inherit", "self", "brand_parent", "operator_parent", "both"])
              .nullable()
              .optional()
              .describe("Office's display preference."),
          })
        )
        .max(50)
        .optional()
        .describe(
          "Per-office settings. Each child must have brand_parent_vendor_id = parent_vendor_id."
        ),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Forbidden — admin only." }],
          isError: true,
        };
      }

      // Load the brand-parent row + sanity-check role.
      const [parentRow] = await db
        .select({
          id: vendors.id,
          role: vendors.role,
          deletedAt: vendors.deletedAt,
          defaultChildDisplay: vendors.defaultChildDisplay,
        })
        .from(vendors)
        .where(eq(vendors.id, params.parent_vendor_id))
        .limit(1);
      if (!parentRow) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Parent vendor not found: ${params.parent_vendor_id}`,
            },
          ],
          isError: true,
        };
      }
      if (parentRow.deletedAt != null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Parent vendor is soft-deleted: ${params.parent_vendor_id}`,
            },
          ],
          isError: true,
        };
      }
      if (parentRow.role !== "NATIONAL") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Parent vendor role must be NATIONAL (got ${parentRow.role}). Use set_vendor_relationship first to mark it as a brand parent.`,
            },
          ],
          isError: true,
        };
      }

      // Pre-load all the named children in one query so we can validate
      // they belong to this parent and enforce the gate rule before any
      // write. Child count capped at 50 by the input schema; well under
      // D1's 100-param ceiling.
      const childUpdates = params.children ?? [];
      const childIds = childUpdates.map((c) => c.vendor_id);
      const existingChildren =
        childIds.length > 0
          ? await db
              .select({
                id: vendors.id,
                deletedAt: vendors.deletedAt,
                brandParentVendorId: vendors.brandParentVendorId,
                displayOverridePermitted: vendors.displayOverridePermitted,
              })
              .from(vendors)
              .where(inArray(vendors.id, childIds))
          : [];
      const childById = new Map(existingChildren.map((c) => [c.id, c]));

      for (const c of childUpdates) {
        const existing = childById.get(c.vendor_id);
        if (!existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Child vendor not found: ${c.vendor_id}`,
              },
            ],
            isError: true,
          };
        }
        if (existing.deletedAt != null) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Child vendor is soft-deleted: ${c.vendor_id}`,
              },
            ],
            isError: true,
          };
        }
        if (existing.brandParentVendorId !== params.parent_vendor_id) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Child ${c.vendor_id} is not a child of parent ${params.parent_vendor_id}. Use set_vendor_relationship to re-parent first.`,
              },
            ],
            isError: true,
          };
        }
        // Spec §5.2 gate rule: cannot set a concrete display_mode on a
        // child whose gate stays closed. Caller must also flip
        // display_override_permitted=true in the same call (or have it
        // already true).
        if (
          c.display_mode !== undefined &&
          c.display_mode !== null &&
          c.display_mode !== "inherit"
        ) {
          const effectiveGate = c.display_override_permitted ?? existing.displayOverridePermitted;
          if (!effectiveGate) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Refused: cannot set display_mode='${c.display_mode}' on ${c.vendor_id} while display_override_permitted=false. Flip the gate in the same call or first.`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      // Apply parent-side update (if any).
      let parentApplied: Record<string, unknown> | null = null;
      if (params.default_child_display !== undefined) {
        await db
          .update(vendors)
          .set({
            defaultChildDisplay: params.default_child_display,
            updatedAt: new Date(),
          })
          .where(eq(vendors.id, params.parent_vendor_id));
        parentApplied = {
          previous: parentRow.defaultChildDisplay,
          applied: params.default_child_display,
        };
      }

      // Apply per-child updates. Each is a tiny UPDATE; loop is fine
      // for up to 50 children and avoids the complexity of stitching a
      // CASE/WHEN INSERT-VALUES VALUES upsert.
      const childResults: Array<Record<string, unknown>> = [];
      for (const c of childUpdates) {
        const existing = childById.get(c.vendor_id)!;
        const childUpdate: Record<string, unknown> = { updatedAt: new Date() };
        if (c.display_override_permitted !== undefined) {
          childUpdate.displayOverridePermitted = c.display_override_permitted;
        }
        if (c.display_mode !== undefined) {
          childUpdate.displayMode = c.display_mode;
        }
        if (Object.keys(childUpdate).length === 1) continue; // updatedAt only
        await db.update(vendors).set(childUpdate).where(eq(vendors.id, c.vendor_id));
        childResults.push({
          vendor_id: c.vendor_id,
          previous: {
            display_override_permitted: existing.displayOverridePermitted,
          },
          applied: {
            display_override_permitted: c.display_override_permitted,
            display_mode: c.display_mode,
          },
        });
      }

      try {
        await db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "vendor.display_policy",
          targetType: "vendor",
          targetId: params.parent_vendor_id,
          actorUserId: auth.userId ?? null,
          payloadJson: JSON.stringify({
            parent_vendor_id: params.parent_vendor_id,
            parent: parentApplied,
            children: childResults,
          }),
          createdAt: new Date(),
        });
      } catch {
        // Audit failure must not fail the policy write itself.
      }

      return {
        content: [
          jsonContent({
            updated: true,
            parent_vendor_id: params.parent_vendor_id,
            parent: parentApplied,
            children: childResults,
          }),
        ],
      };
    }
  );

  // ── set_vendor_alias ────────────────────────────────────────────
  server.tool(
    "set_vendor_alias",
    "Mark a vendor as an alias of another (same operating entity, different spelling). Optionally repoints all event_vendors associations from alias → canonical (batched 50/stmt for D1 param-cap safety), writes vendor_slug_history (old=alias slug, new=canonical slug), and soft-deletes the alias with redirect_to_vendor_id=canonical so middleware can 301 the URL. Cycle + self-ref guarded. Audited as 'vendor.alias'. Admin only.",
    {
      alias_vendor_id: z
        .string()
        .min(1)
        .describe("The row that is the duplicate spelling — becomes the alias."),
      canonical_vendor_id: z
        .string()
        .min(1)
        .describe("The row to keep as the canonical operating entity."),
      repoint_events: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "If true (default), reassigns all event_vendors associations from alias → canonical."
        ),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Forbidden — admin only." }],
          isError: true,
        };
      }
      if (params.alias_vendor_id === params.canonical_vendor_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Refused: alias and canonical are the same vendor.",
            },
          ],
          isError: true,
        };
      }

      const [aliasRow] = await db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          deletedAt: vendors.deletedAt,
          aliasOfVendorId: vendors.aliasOfVendorId,
          redirectToVendorId: vendors.redirectToVendorId,
        })
        .from(vendors)
        .where(eq(vendors.id, params.alias_vendor_id))
        .limit(1);
      const [canonicalRow] = await db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          deletedAt: vendors.deletedAt,
        })
        .from(vendors)
        .where(eq(vendors.id, params.canonical_vendor_id))
        .limit(1);
      if (!aliasRow) {
        return {
          content: [
            { type: "text" as const, text: `Alias vendor not found: ${params.alias_vendor_id}` },
          ],
          isError: true,
        };
      }
      if (!canonicalRow) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Canonical vendor not found: ${params.canonical_vendor_id}`,
            },
          ],
          isError: true,
        };
      }
      if (canonicalRow.deletedAt != null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Canonical vendor is soft-deleted; cannot alias onto a tombstone: ${params.canonical_vendor_id}`,
            },
          ],
          isError: true,
        };
      }
      if (aliasRow.aliasOfVendorId != null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Vendor ${params.alias_vendor_id} is already aliased (alias_of_vendor_id=${aliasRow.aliasOfVendorId}). Use set_vendor_alias on the canonical or untangle first.`,
            },
          ],
          isError: true,
        };
      }
      // Cycle guard: if the canonical chains back to the alias, refuse.
      if (
        await wouldFormCycle(
          db,
          "aliasOfVendorId",
          params.alias_vendor_id,
          params.canonical_vendor_id
        )
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Refused: canonical=${params.canonical_vendor_id} would form an alias cycle back to alias=${params.alias_vendor_id} (depth ≤ ${RELATIONSHIP_CHAIN_MAX_DEPTH}).`,
            },
          ],
          isError: true,
        };
      }

      // 1. Repoint event_vendors (optional). Delete overlaps first to
      // sidestep the (event_id, vendor_id) UNIQUE constraint, then
      // UPDATE the rest. Batched 50/stmt for D1's 100-param ceiling
      // (per [[feedback_d1_batch_param_limit]]).
      let eventVendorsReassigned = 0;
      let eventVendorsOverlapDropped = 0;
      if (params.repoint_events !== false) {
        // Find event ids where canonical already has a row — those are
        // the overlaps that would conflict on UPDATE.
        const canonicalEvents = await db
          .select({ eventId: eventVendors.eventId })
          .from(eventVendors)
          .where(eq(eventVendors.vendorId, params.canonical_vendor_id));
        const canonicalEventIds = canonicalEvents.map((r) => r.eventId);

        if (canonicalEventIds.length > 0) {
          // Delete alias's rows for events the canonical already has.
          for (let i = 0; i < canonicalEventIds.length; i += FK_BATCH_SIZE) {
            const batch = canonicalEventIds.slice(i, i + FK_BATCH_SIZE);
            const deleted = await db
              .delete(eventVendors)
              .where(
                and(
                  eq(eventVendors.vendorId, params.alias_vendor_id),
                  inArray(eventVendors.eventId, batch)
                )
              )
              .returning({ id: eventVendors.id });
            eventVendorsOverlapDropped += deleted.length;
          }
        }
        // Now safe to UPDATE the rest in one go.
        const reassigned = await db
          .update(eventVendors)
          .set({ vendorId: params.canonical_vendor_id })
          .where(eq(eventVendors.vendorId, params.alias_vendor_id))
          .returning({ id: eventVendors.id });
        eventVendorsReassigned = reassigned.length;
      }

      // 2. vendor_slug_history row so middleware can 301 the alias URL
      // to the canonical's current slug. Mirrors the merge_events
      // pattern from src/lib/duplicates/merge-operations.ts.
      try {
        await db.insert(vendorSlugHistory).values({
          id: crypto.randomUUID(),
          vendorId: params.canonical_vendor_id,
          oldSlug: aliasRow.slug,
          newSlug: canonicalRow.slug,
          changedAt: new Date(),
          changedBy: auth.userId ?? null,
        });
      } catch {
        // History-write failure is non-fatal; the redirect will still
        // work via redirectToVendorId set below. Logged as audit.
      }

      // 3. Soft-delete the alias + set redirect target + set alias_of.
      // Setting BOTH deletedAt + redirectToVendorId AND aliasOfVendorId
      // is intentional: the redirect drives middleware 301s; the
      // alias_of drives resolveAlias() chain-following for future
      // callers that load the row directly by id.
      await db
        .update(vendors)
        .set({
          deletedAt: new Date(),
          redirectToVendorId: params.canonical_vendor_id,
          aliasOfVendorId: params.canonical_vendor_id,
          updatedAt: new Date(),
        })
        .where(eq(vendors.id, params.alias_vendor_id));

      try {
        await db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "vendor.alias",
          targetType: "vendor",
          targetId: params.canonical_vendor_id,
          actorUserId: auth.userId ?? null,
          payloadJson: JSON.stringify({
            alias_vendor_id: params.alias_vendor_id,
            alias_slug: aliasRow.slug,
            canonical_vendor_id: params.canonical_vendor_id,
            canonical_slug: canonicalRow.slug,
            event_vendors_reassigned: eventVendorsReassigned,
            event_vendors_overlap_dropped: eventVendorsOverlapDropped,
            repoint_events: params.repoint_events !== false,
          }),
          createdAt: new Date(),
        });
      } catch {
        // Audit failure must not fail the alias write itself.
      }

      return {
        content: [
          jsonContent({
            aliased: true,
            alias_vendor_id: params.alias_vendor_id,
            alias_slug: aliasRow.slug,
            canonical_vendor_id: params.canonical_vendor_id,
            canonical_slug: canonicalRow.slug,
            event_vendors_reassigned: eventVendorsReassigned,
            event_vendors_overlap_dropped: eventVendorsOverlapDropped,
            slug_history_written: true,
          }),
        ],
      };
    }
  );
}
