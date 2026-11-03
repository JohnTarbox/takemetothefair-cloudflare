/**
 * OPE-328 (Demux D-3) — the agent side of the gemba@ queue.
 *
 * The Worker holds no Linear credential (John's ruling, 2026-09-30), so a gemba
 * email is recorded in `gemba_observations` and an agent session — which does
 * have Linear — posts it to the project's anchor issue and marks it posted.
 * A `held` row could not be tagged unambiguously; the agent asks John which
 * project it belongs to and re-routes it here, never guessing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { gembaObservations, inboundEmails } from "../schema.js";
import { GEMBA_ANCHORS } from "../inbound/gemba.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerGembaTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_gemba_observations",
    "List gemba@ observations queued for posting (OPE-328). 'pending' rows carry the Linear anchor issue to comment on (MMATF → OPE-86); 'held' rows could not be tagged to one project and need John to say which. Each row includes the email's subject and body so it can be posted verbatim. After posting, call mark_gemba_observation. Admin only.",
    {
      status: z.enum(["pending", "held", "posted"]).optional().default("pending"),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async (params) => {
      const rows = await db
        .select({
          id: gembaObservations.id,
          inboundEmailId: gembaObservations.inboundEmailId,
          project: gembaObservations.project,
          anchorIssue: gembaObservations.anchorIssue,
          status: gembaObservations.status,
          routingReason: gembaObservations.routingReason,
          postedRef: gembaObservations.postedRef,
          createdAt: gembaObservations.createdAt,
          fromAddress: inboundEmails.fromAddress,
          subject: inboundEmails.subject,
          body: inboundEmails.bodyText,
          receivedAt: inboundEmails.receivedAt,
        })
        .from(gembaObservations)
        .leftJoin(inboundEmails, eq(inboundEmails.id, gembaObservations.inboundEmailId))
        .where(eq(gembaObservations.status, params.status))
        .orderBy(asc(gembaObservations.createdAt))
        .limit(params.limit);
      return { content: [jsonContent({ count: rows.length, observations: rows })] };
    }
  );

  server.tool(
    "mark_gemba_observation",
    "Record what happened to a gemba@ observation (OPE-328): action 'posted' with the Linear comment id/URL you created on its anchor issue, or action 'route' to assign a held row to a project once John has said which (it becomes pending with that project's anchor). Admin only.",
    {
      id: z.string().min(1),
      action: z.enum(["posted", "route"]),
      posted_ref: z
        .string()
        .min(1)
        .optional()
        .describe("Linear comment id or URL (action 'posted')."),
      project: z
        .enum(["mmatf", "cardworks", "engine-ops"])
        .optional()
        .describe("Project (action 'route')."),
    },
    async (params) => {
      const [row] = await db
        .select()
        .from(gembaObservations)
        .where(eq(gembaObservations.id, params.id))
        .limit(1);
      if (!row) return { content: [jsonContent({ error: "not_found" })], isError: true };
      if (params.action === "posted") {
        if (!params.posted_ref) {
          return { content: [jsonContent({ error: "posted_ref required" })], isError: true };
        }
        if (row.status !== "pending") {
          return {
            content: [jsonContent({ error: "not_pending", status: row.status })],
            isError: true,
          };
        }
        await db
          .update(gembaObservations)
          .set({ status: "posted", postedRef: params.posted_ref, postedAt: new Date() })
          .where(eq(gembaObservations.id, row.id));
        return {
          content: [jsonContent({ id: row.id, status: "posted", posted_ref: params.posted_ref })],
        };
      }
      if (!params.project)
        return { content: [jsonContent({ error: "project required" })], isError: true };
      const anchor = GEMBA_ANCHORS[params.project] ?? null;
      if (!anchor) {
        return {
          content: [
            jsonContent({
              error: "no_anchor",
              message: `${params.project} has no gemba anchor issue yet; the row stays held.`,
            }),
          ],
          isError: true,
        };
      }
      await db
        .update(gembaObservations)
        .set({
          status: "pending",
          project: params.project,
          anchorIssue: anchor,
          routingReason: `routed by operator: ${params.project}`,
        })
        .where(eq(gembaObservations.id, row.id));
      return {
        content: [jsonContent({ id: row.id, status: "pending", project: params.project, anchor })],
      };
    }
  );
}
