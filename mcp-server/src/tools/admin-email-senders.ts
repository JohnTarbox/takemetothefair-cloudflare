/**
 * MCP tools for inbound email sender quality + trust annotation.
 *
 * Sister surface to the /admin/inbound-emails "Sender summary" panel —
 * exposes the same aggregated data plus a write path for setting
 * trust_status on a sender. Cowork / Claude can use these for ad-hoc
 * "is this sender legitimate" questions during admin triage without
 * needing the admin to open the page.
 *
 * - get_email_submitter_quality (read) — top N senders with outcome
 *   breakdown, top state, out-of-area flag, trust annotation.
 * - set_email_sender_trust (write) — upsert one row in
 *   inbound_email_senders. Audit-logged via admin_actions.
 *
 * Both tools are admin-only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { adminActions, events, inboundEmails, inboundEmailSenders } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const NE_STATES = new Set(["ME", "NH", "VT", "MA", "CT", "RI"]);

const TRUST_VALUES = ["unknown", "trusted", "watchlist", "blocked"] as const;
type TrustValue = (typeof TRUST_VALUES)[number];

interface SenderSummary {
  fromAddress: string;
  total: number;
  replied: number;
  failed: number;
  eventsCreated: number;
  approved: number;
  pending: number;
  rejected: number;
  approvalRate: number | null;
  noEventOk: number;
  topState: string | null;
  outOfArea: boolean;
  stateBreakdown: Array<{ state: string; n: number }>;
  firstSeen: string;
  lastSeen: string;
  trustStatus: TrustValue;
  notes: string | null;
}

/**
 * Compute the same per-sender breakdown the admin page uses. Pure
 * drizzle queries — no HTTP. Shared between the two tools below and
 * easy to unit-test against an in-memory drizzle.
 */
async function computeSenderSummaries(db: Db, limit: number): Promise<SenderSummary[]> {
  const inboundRows = await db
    .select({
      fromAddress: inboundEmails.fromAddress,
      total: sql<number>`COUNT(*)`,
      replied: sql<number>`SUM(CASE WHEN ${inboundEmails.status} = 'replied' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${inboundEmails.status} = 'failed' THEN 1 ELSE 0 END)`,
      firstSeen: sql<number>`MIN(${inboundEmails.receivedAt})`,
      lastSeen: sql<number>`MAX(${inboundEmails.receivedAt})`,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.intent, "submit"))
    .groupBy(inboundEmails.fromAddress);

  const eventRows = await db
    .select({
      suggesterEmail: events.suggesterEmail,
      eventsCreated: sql<number>`COUNT(*)`,
      approved: sql<number>`SUM(CASE WHEN ${events.status} = 'APPROVED' THEN 1 ELSE 0 END)`,
      pending: sql<number>`SUM(CASE WHEN ${events.status} = 'PENDING' THEN 1 ELSE 0 END)`,
      rejected: sql<number>`SUM(CASE WHEN ${events.status} = 'REJECTED' THEN 1 ELSE 0 END)`,
    })
    .from(events)
    .where(sql`${events.sourceName} = 'email-submission' AND ${events.suggesterEmail} IS NOT NULL`)
    .groupBy(events.suggesterEmail);

  const stateRows = await db
    .select({
      suggesterEmail: events.suggesterEmail,
      stateCode: events.stateCode,
      n: sql<number>`COUNT(*)`,
    })
    .from(events)
    .where(
      sql`${events.sourceName} = 'email-submission' AND ${events.suggesterEmail} IS NOT NULL AND ${events.stateCode} IS NOT NULL`
    )
    .groupBy(events.suggesterEmail, events.stateCode);

  const trustRows = await db
    .select({
      email: inboundEmailSenders.email,
      trustStatus: inboundEmailSenders.trustStatus,
      notes: inboundEmailSenders.notes,
    })
    .from(inboundEmailSenders);

  const eventByEmail = new Map(eventRows.map((r) => [r.suggesterEmail ?? "", r]));
  const statesByEmail = new Map<string, Array<{ state: string; n: number }>>();
  for (const r of stateRows) {
    if (!r.suggesterEmail || !r.stateCode) continue;
    const list = statesByEmail.get(r.suggesterEmail) ?? [];
    list.push({ state: r.stateCode, n: r.n });
    statesByEmail.set(r.suggesterEmail, list);
  }
  const trustByEmail = new Map(trustRows.map((r) => [r.email, r]));

  return inboundRows
    .map((i) => {
      const e = eventByEmail.get(i.fromAddress);
      const states = (statesByEmail.get(i.fromAddress) ?? []).sort((a, b) => b.n - a.n);
      const topState = states[0]?.state ?? null;
      const totalStateCounted = states.reduce((s, v) => s + v.n, 0);
      const neCount = states.filter((s) => NE_STATES.has(s.state)).reduce((s, v) => s + v.n, 0);
      const outOfArea = totalStateCounted > 0 && neCount / totalStateCounted < 0.5;
      const eventsCreated = e?.eventsCreated ?? 0;
      const approved = e?.approved ?? 0;
      const trust = trustByEmail.get(i.fromAddress);
      return {
        fromAddress: i.fromAddress,
        total: i.total,
        replied: i.replied,
        failed: i.failed,
        eventsCreated,
        approved,
        pending: e?.pending ?? 0,
        rejected: e?.rejected ?? 0,
        approvalRate: eventsCreated > 0 ? approved / eventsCreated : null,
        noEventOk: i.replied - eventsCreated,
        topState,
        outOfArea,
        stateBreakdown: states,
        firstSeen: new Date(i.firstSeen * 1000).toISOString(),
        lastSeen: new Date(i.lastSeen * 1000).toISOString(),
        trustStatus: (trust?.trustStatus ?? "unknown") as TrustValue,
        notes: trust?.notes ?? null,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export function registerEmailSenderTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_email_submitter_quality",
    "Per-sender breakdown of inbound email submissions: volume, event outcomes (approved/pending/rejected), top state, out-of-area flag (>50% non-New-England), and operator-set trust annotation. Use for triaging 'is this sender legitimate' questions. Admin only.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Top N senders by volume (default 50, max 200)."),
      filter_email: z
        .string()
        .email()
        .optional()
        .describe(
          "Return only this single sender's row. Useful when triaging a specific inbound email and you want full context on the address."
        ),
    },
    async (params) => {
      const limit = typeof params.limit === "number" ? params.limit : 50;
      const allSenders = await computeSenderSummaries(db, 200);
      const filterEmail = params.filter_email;
      const filtered =
        typeof filterEmail === "string"
          ? allSenders.filter((s) => s.fromAddress.toLowerCase() === filterEmail.toLowerCase())
          : allSenders.slice(0, limit);
      return {
        content: [
          jsonContent({
            count: filtered.length,
            senders: filtered,
          }),
        ],
      };
    }
  );

  server.tool(
    "set_email_sender_trust",
    "Set operator trust annotation on an inbound email sender. trust_status values: unknown, trusted, watchlist, blocked. UPSERTs the row in inbound_email_senders. Audit-logged. Admin only.",
    {
      email: z.string().email().describe("Sender email address (lowercased on store)."),
      trust_status: z
        .enum(TRUST_VALUES)
        .describe(
          "trusted = known-good submitter; watchlist = suspect, flag in queue; blocked = drop on receipt (not yet wired to entrypoint); unknown = reset."
        ),
      notes: z
        .string()
        .max(1000)
        .optional()
        .describe("Free-form admin note. Replaces any prior notes; pass empty string to clear."),
    },
    async (params) => {
      const normalizedEmail = params.email.toLowerCase().trim();
      const now = new Date();
      const notes = typeof params.notes === "string" ? params.notes : null;

      // Drizzle's onConflictDoUpdate works fine here because email is
      // the PK and we want a real UPSERT (not the partial-index hack
      // that bit us earlier today on inbound_emails.message_id).
      await db
        .insert(inboundEmailSenders)
        .values({
          email: normalizedEmail,
          trustStatus: params.trust_status,
          notes,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: inboundEmailSenders.email,
          set: {
            trustStatus: params.trust_status,
            notes,
            updatedAt: now,
          },
        });

      // Audit-log the change for /admin/logs visibility.
      await db.insert(adminActions).values({
        action: "inbound_sender.set_trust",
        actorUserId: auth.userId ?? null,
        targetType: "inbound_email_sender",
        targetId: normalizedEmail,
        payloadJson: JSON.stringify({
          trustStatus: params.trust_status,
          notes,
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            ok: true,
            email: normalizedEmail,
            trustStatus: params.trust_status,
            notes,
          }),
        ],
      };
    }
  );
}
