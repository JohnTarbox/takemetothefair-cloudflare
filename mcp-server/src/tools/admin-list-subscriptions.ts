/**
 * OPE-1265 — the registry of promoter mailing lists MMATF subscribed to.
 *
 * The signup itself is done by hand (the analyst pilot, OPE-1266): fill the
 * promoter's form with lists+<slug>@meetmeatthefair.com, then record it here as
 * `requested`. Arrivals at that address update the row automatically
 * (email-handlers/list-subscription.ts); a double-opt-in mail puts its confirm
 * link on the row, which the analyst opens BY HAND — this surface never fetches
 * it (auto-confirming is a separate decision for John: OPE-992 SSRF surface).
 *
 * ⚠️ The address is for signups we make ourselves. Do not publish it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { promoterListArrivals, promoterListSubscriptions, promoters } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const DAY_MS = 86_400_000;
const STATUSES = ["requested", "confirmed", "active", "unsubscribed", "bounced"] as const;

/** The address a promoter's signup should use. */
export function listAddressFor(slug: string): string {
  return `lists+${slug}@meetmeatthefair.com`;
}

/**
 * Scope 7 — how long since the last issue, against this list's own cadence.
 * `typicalGapDays` is the median gap between issue arrivals (needs ≥ 3 issues);
 * a list goes `silent` when it has gone more than twice that without one. A
 * list with too little history is never called silent — absence of a cadence
 * is not evidence of a stopped one.
 */
export function listHealth(
  issueArrivalTimes: number[],
  lastReceivedAt: Date | null,
  now: Date
): { daysSinceLastIssue: number | null; typicalGapDays: number | null; silent: boolean } {
  const daysSinceLastIssue = lastReceivedAt
    ? Math.floor((now.getTime() - lastReceivedAt.getTime()) / DAY_MS)
    : null;
  const t = [...issueArrivalTimes].sort((a, b) => a - b);
  if (t.length < 3 || daysSinceLastIssue === null) {
    return { daysSinceLastIssue, typicalGapDays: null, silent: false };
  }
  const gaps = t
    .slice(1)
    .map((v, i) => (v - t[i]) / DAY_MS)
    .sort((a, b) => a - b);
  const typicalGapDays = Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10;
  return { daysSinceLastIssue, typicalGapDays, silent: daysSinceLastIssue > 2 * typicalGapDays };
}

export function registerListSubscriptionTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "create_list_subscription",
    "OPE-1265 — record that MMATF signed up to a promoter's mailing list. Creates a 'requested' row for (promoter, address). The address defaults to lists+<promoter-slug>@meetmeatthefair.com (use plain lists@meetmeatthefair.com only when the signup form rejects '+'). Do the signup BY HAND first; this tool only records it. Never publish the address. Admin only.",
    {
      promoter_id: z.string().optional(),
      promoter_slug: z.string().optional(),
      address: z.string().email().optional(),
      signup_url: z.string().url().optional(),
      esp: z
        .string()
        .max(80)
        .optional()
        .describe("The email service, if known (Mailchimp, Constant Contact…)."),
      note: z.string().max(500).optional(),
    },
    async (params) => {
      const [p] = await db
        .select({ id: promoters.id, slug: promoters.slug, name: promoters.companyName })
        .from(promoters)
        .where(
          params.promoter_id
            ? eq(promoters.id, params.promoter_id)
            : eq(promoters.slug, (params.promoter_slug ?? "") as never)
        )
        .limit(1);
      if (!p) {
        return {
          content: [
            jsonContent({ error: "promoter not found (pass promoter_id or promoter_slug)" }),
          ],
          isError: true,
        };
      }
      const address = (params.address ?? listAddressFor(p.slug)).toLowerCase();
      const now = new Date();
      const inserted = await db
        .insert(promoterListSubscriptions)
        .values({
          promoterId: p.id,
          address,
          signupUrl: params.signup_url ?? null,
          esp: params.esp ?? null,
          status: "requested",
          requestedAt: now,
          note: params.note ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: promoterListSubscriptions.id });
      const [row] = await db
        .select()
        .from(promoterListSubscriptions)
        .where(
          and(
            eq(promoterListSubscriptions.promoterId, p.id),
            eq(promoterListSubscriptions.address, address)
          )
        )
        .limit(1);
      return {
        content: [
          jsonContent({
            created: inserted.length > 0,
            already_existed: inserted.length === 0,
            promoter: { id: p.id, slug: p.slug, name: p.name },
            subscription: row,
          }),
        ],
      };
    }
  );

  server.tool(
    "list_list_subscriptions",
    "OPE-1265 — list MMATF's promoter mailing-list subscriptions with health: days since the last issue, the list's typical gap between issues, and `silent` (no issue for > 2× its typical gap — unsubscribed by the sender, bounced, or the promoter folded). A row awaiting confirmation shows its confirm_url, to be opened BY HAND. Also returns recent unattributed arrivals (mail to lists@ with no or an unknown plus-tag). Admin only.",
    {
      status: z.enum(STATUSES).optional(),
      promoter_id: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async (params) => {
      const conds = [];
      if (params.status) conds.push(eq(promoterListSubscriptions.status, params.status));
      if (params.promoter_id)
        conds.push(eq(promoterListSubscriptions.promoterId, params.promoter_id));
      const rows = await db
        .select({
          sub: promoterListSubscriptions,
          promoterSlug: promoters.slug,
          promoterName: promoters.companyName,
        })
        .from(promoterListSubscriptions)
        .leftJoin(promoters, eq(promoters.id, promoterListSubscriptions.promoterId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(promoterListSubscriptions.status), desc(promoterListSubscriptions.updatedAt))
        .limit(params.limit ?? 50);

      const now = new Date();
      const out = [];
      for (const r of rows) {
        const issues = await db
          .select({
            at: promoterListArrivals.createdAt,
            mismatch: promoterListArrivals.senderMismatch,
          })
          .from(promoterListArrivals)
          .where(
            and(
              eq(promoterListArrivals.subscriptionId, r.sub.id),
              eq(promoterListArrivals.kind, "issue")
            )
          );
        out.push({
          ...r.sub,
          promoter_slug: r.promoterSlug,
          promoter_name: r.promoterName,
          ...listHealth(
            issues.map((i) => i.at.getTime()),
            r.sub.lastReceivedAt,
            now
          ),
          sender_mismatch_issues: issues.filter((i) => i.mismatch === 1).length,
        });
      }
      const unattributed = await db
        .select()
        .from(promoterListArrivals)
        .where(eq(promoterListArrivals.matchBasis, "unattributed"))
        .orderBy(desc(promoterListArrivals.createdAt))
        .limit(20);
      return {
        content: [
          jsonContent({ count: out.length, subscriptions: out, recent_unattributed: unattributed }),
        ],
      };
    }
  );

  server.tool(
    "update_list_subscription",
    "OPE-1265 — change a subscription's status: 'confirmed' after you open its confirm link by hand (stamps confirmed_at), 'unsubscribed' or 'bounced' when it ends. The first issue after 'confirmed' moves it to 'active' automatically. Admin only.",
    {
      id: z.string(),
      status: z.enum(STATUSES),
      note: z.string().max(500).optional(),
    },
    async (params) => {
      const now = new Date();
      const [before] = await db
        .select()
        .from(promoterListSubscriptions)
        .where(eq(promoterListSubscriptions.id, params.id))
        .limit(1);
      if (!before) {
        return { content: [jsonContent({ error: "subscription not found" })], isError: true };
      }
      await db
        .update(promoterListSubscriptions)
        .set({
          status: params.status,
          ...(params.status === "confirmed" && !before.confirmedAt ? { confirmedAt: now } : {}),
          ...(params.note !== undefined ? { note: params.note } : {}),
          updatedAt: now,
        })
        .where(eq(promoterListSubscriptions.id, params.id));
      const [after] = await db
        .select()
        .from(promoterListSubscriptions)
        .where(eq(promoterListSubscriptions.id, params.id))
        .limit(1);
      return { content: [jsonContent({ before: { status: before.status }, subscription: after })] };
    }
  );
}
