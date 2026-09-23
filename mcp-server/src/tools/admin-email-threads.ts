/**
 * OPE-768 scopes 4 + 5 — read a conversation whole, and thread the history.
 *
 * Before this, "what has this person said and what did we say back" took
 * `get_inbound_email` plus `get_sent_emails` plus reconciling the two by hand;
 * John did exactly that for Celina Daigle on 2026-09-02.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { chunkIds } from "@takemetothefair/utils";
import { adminActions, emailSendLedger, inboundEmails, inboundEmailSenders } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { planThreadBackfill } from "../inbound/thread-backfill.js";

const EXCERPT = 400;
const excerpt = (s: string | null | undefined) =>
  s ? s.replace(/\s+/g, " ").trim().slice(0, EXCERPT) : null;

export function registerEmailThreadTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_email_thread",
    [
      "OPE-768 — the whole conversation an inbound email belongs to: every message IN",
      "(inbound_emails on the same thread_id) and every message OUT (email_send_ledger rows",
      "tied to those inbound rows), merged in time order, with body excerpts. Also lists the",
      "sender's OTHER threads, because one person can hold several conversations (Heather",
      "Santiago wrote 'account' and 'booth set up' ten minutes apart). Replies sent from Gmail",
      "never reach the ledger, so an absent outbound message is not proof nobody answered.",
      "Read-only. Admin only.",
    ].join(" "),
    {
      inbound_email_id: z.string().min(8).describe("Any inbound_emails.id in the conversation."),
    },
    async ({ inbound_email_id }) => {
      const [row] = await db
        .select()
        .from(inboundEmails)
        .where(eq(inboundEmails.id, inbound_email_id))
        .limit(1);
      if (!row) {
        return {
          content: [{ type: "text" as const, text: `No inbound email ${inbound_email_id}.` }],
          isError: true,
        };
      }

      // A row that predates threading is its own one-message conversation —
      // reported as such, not silently widened.
      const inbound = row.threadId
        ? await db
            .select()
            .from(inboundEmails)
            .where(eq(inboundEmails.threadId, row.threadId))
            .orderBy(asc(inboundEmails.receivedAt))
            .limit(200)
        : [row];

      const ids = inbound.map((r) => r.id);
      const sends: (typeof emailSendLedger.$inferSelect)[] = [];
      for (const chunk of chunkIds(ids)) {
        sends.push(
          ...(await db
            .select()
            .from(emailSendLedger)
            .where(inArray(emailSendLedger.inboundEmailId, chunk)))
        );
      }

      const messages = [
        ...inbound.map((r) => ({
          direction: "in" as const,
          at: r.receivedAt,
          id: r.id,
          from: r.fromAddress,
          to: r.toAddress,
          subject: r.subject,
          intent: r.intent,
          threadPosition: r.threadPosition,
          threadBasis: r.threadBasis,
          excerpt: excerpt(r.bodyText ?? r.bodyTextExcerpt),
        })),
        ...sends.map((s) => ({
          direction: "out" as const,
          at: s.sentAt,
          id: s.messageId,
          from: null,
          to: s.recipient,
          subject: s.subject,
          source: s.source,
          status: s.status,
          deliveryStatus: s.deliveryStatus,
          inReplyToInbound: s.inboundEmailId,
          excerpt: excerpt(s.bodyText),
        })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

      const otherThreads = row.fromAddress
        ? await db
            .select({
              id: inboundEmails.id,
              threadId: inboundEmails.threadId,
              subject: inboundEmails.subject,
              receivedAt: inboundEmails.receivedAt,
            })
            .from(inboundEmails)
            .where(
              and(
                eq(inboundEmails.fromAddress, row.fromAddress),
                row.threadId
                  ? ne(inboundEmails.threadId, row.threadId)
                  : ne(inboundEmails.id, row.id)
              )
            )
            .orderBy(desc(inboundEmails.receivedAt))
            .limit(25)
        : [];

      return {
        content: [
          jsonContent({
            threadId: row.threadId,
            threaded: row.threadId !== null,
            messageCount: messages.length,
            messages,
            sameSenderOtherMessages: otherThreads,
            caveat:
              "Outbound = email_send_ledger only. A reply sent from Gmail is not recorded there. threaded=false means the row predates threading (run backfill_email_threads).",
          }),
        ],
      };
    }
  );

  server.tool(
    "backfill_email_threads",
    [
      "OPE-768 scope 5 — assign thread_id/position/basis to inbound_emails rows that predate",
      "threading (thread_id IS NULL), using the SAME resolver as ingest, row by row in receipt",
      "order. DRY RUN BY DEFAULT: returns the basis counts (header_chain / operator_forward /",
      "subject_participants / new) and the multi-message threads it would form, and writes",
      "nothing. dry_run=false writes only rows still NULL (idempotent), reads them back, and",
      "logs the id list to admin_actions for rollback. Best-effort: unmatched rows stay",
      "singletons rather than being guessed together. Admin only.",
    ].join(" "),
    {
      dry_run: z.boolean().optional().default(true),
    },
    async ({ dry_run }) => {
      const rows = await db
        .select({
          id: inboundEmails.id,
          receivedAt: inboundEmails.receivedAt,
          fromAddress: inboundEmails.fromAddress,
          toAddress: inboundEmails.toAddress,
          subject: inboundEmails.subject,
          messageId: inboundEmails.messageId,
          inReplyTo: inboundEmails.inReplyTo,
          emailReferences: inboundEmails.emailReferences,
          originalSenderAddress: inboundEmails.originalSenderAddress,
          threadId: inboundEmails.threadId,
          threadPosition: inboundEmails.threadPosition,
        })
        .from(inboundEmails);

      const ledger = await db
        .select({
          providerMessageId: emailSendLedger.providerMessageId,
          inboundEmailId: emailSendLedger.inboundEmailId,
        })
        .from(emailSendLedger);

      const trusted = new Set(
        (
          await db
            .select({ email: inboundEmailSenders.email })
            .from(inboundEmailSenders)
            .where(eq(inboundEmailSenders.trustStatus, "trusted"))
        ).map((t) => t.email.trim().toLowerCase())
      );

      const plan = planThreadBackfill(
        rows.map((r) => ({ ...r, receivedAt: new Date(r.receivedAt).getTime() })),
        ledger,
        trusted,
        () => crypto.randomUUID()
      );

      const byThread = new Map<string, string[]>();
      for (const a of plan.assignments) {
        byThread.set(a.threadId, [...(byThread.get(a.threadId) ?? []), a.id]);
      }
      const rowById = new Map(rows.map((r) => [r.id, r]));
      const formed = [...byThread.entries()]
        .filter(([, ids]) => ids.length > 1)
        .slice(0, 40)
        .map(([threadId, ids]) => ({
          threadId,
          messages: ids.map((id) => ({
            id,
            from: rowById.get(id)?.fromAddress ?? null,
            subject: rowById.get(id)?.subject ?? null,
            basis: plan.assignments.find((a) => a.id === id)?.threadBasis,
          })),
        }));

      const summary = {
        rowsNeedingThread: plan.assignments.length,
        byBasis: plan.byBasis,
        multiMessageThreads: plan.multiMessageThreads,
        singletons: plan.singletons,
        formedThreadsSample: formed,
      };

      if (dry_run) {
        return { content: [jsonContent({ dryRun: true, ...summary })] };
      }

      // Single writer, idempotent (IS NULL guard), batched per statement well
      // under D1's parameter cap, then read back.
      for (let i = 0; i < plan.assignments.length; i += 50) {
        const slice = plan.assignments.slice(i, i + 50);
        const stmts = slice.map((a) =>
          db
            .update(inboundEmails)
            .set({
              threadId: a.threadId,
              threadPosition: a.threadPosition,
              threadBasis: a.threadBasis,
            })
            .where(and(eq(inboundEmails.id, a.id), isNull(inboundEmails.threadId)))
        );
        if (stmts.length > 0) await db.batch(stmts as [(typeof stmts)[0], ...typeof stmts]);
      }

      let stillNull = 0;
      for (const chunk of chunkIds(plan.assignments.map((a) => a.id))) {
        stillNull += (
          await db
            .select({ id: inboundEmails.id })
            .from(inboundEmails)
            .where(and(inArray(inboundEmails.id, chunk), isNull(inboundEmails.threadId)))
        ).length;
      }

      await db.insert(adminActions).values({
        action: "inbound.thread_backfill",
        actorUserId: auth.userId ?? null,
        targetType: "inbound_emails",
        targetId: "thread_backfill",
        // The rollback: UPDATE inbound_emails SET thread_id=NULL,
        // thread_position=NULL, thread_basis=NULL WHERE id IN (<ids>).
        payloadJson: JSON.stringify({
          ids: plan.assignments.map((a) => a.id),
          byBasis: plan.byBasis,
        }),
        createdAt: new Date(),
      });

      return {
        content: [
          jsonContent({ dryRun: false, written: plan.assignments.length, stillNull, ...summary }),
        ],
      };
    }
  );
}
