/**
 * OPE-499 — an agent read surface for the inbound-correspondence lane.
 *
 * `inbound_correspondence` is a named fault source, and every fault ever found
 * in it was found by a human opening /admin and reading. Four viewers shipped
 * (OPE-152, 155, 156, 187) and none had an MCP equivalent, so an agent asked to
 * review a submission could not read the submission — every finding was an
 * inference from the row the pipeline produced.
 *
 * The 2026-08-20 specimen is the case in point: a review of `c00f0865…` found a
 * fabricated 2026-09-01 → 09-30 span and six citations stamped to sources that
 * cannot support them, and had input-side facts only because John pasted the
 * admin record into chat by hand.
 *
 * All read-only, all admin-gated. No writers — these add no queue inflow, which
 * is why they are not Phase-0 gated.
 *
 * PII: submitter addresses are outside-contributor data. These tools are
 * admin-only, the same gate /admin sits behind, so they return what the admin
 * viewer returns and deliberately do NOT invent a looser policy.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte, lte, like, sql } from "drizzle-orm";
import { emailSendLedger, events, inboundEmails, workflowRunSteps } from "../schema.js";
import { jsonContent } from "../helpers.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** MCP tool envelope around `jsonContent`, which returns a content ITEM. */
function contentOf(payload: unknown) {
  return { content: [jsonContent(payload)] };
}

/** Parse a JSON column without letting one malformed row kill the read. */
function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface OcrRecord {
  key: string;
  name: string;
  chars: number;
  outcome: string;
  markdown: string | null;
}

export function registerInboundReadTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: MainAppEnv & {
    INBOUND_EMAIL?: { get(id: string): Promise<{ status(): Promise<unknown> }> };
  }
) {
  if (auth.role !== "ADMIN") return;

  // --- get_inbound_email ---------------------------------------------------
  server.tool(
    "get_inbound_email",
    "Read one inbound email in full — the INPUT side of a submission. Returns sender, subject, the complete body (not the 500-char excerpt), the parsed URL, classifier intent, workflow instance id, reply kind, resulting event, attachment refs/skips, and an OCR summary per attachment. Use this before writing any finding about a submission, so the finding cites what arrived rather than inferring it from the row that came out. Read-only. Admin only.",
    {
      inbound_email_id: z.string().describe("inbound_emails.id"),
      include_body_html: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include the raw HTML body as well as the text body. Off by default — it is large and rarely what you want."
        ),
      include_ocr_text: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include each attachment's full OCR markdown. Off makes the response a summary."),
    },
    async (params) => {
      const [row] = await db
        .select()
        .from(inboundEmails)
        .where(eq(inboundEmails.id, params.inbound_email_id))
        .limit(1);

      if (!row) {
        return {
          content: [
            jsonContent({
              error: "inbound_email_not_found",
              inbound_email_id: params.inbound_email_id,
            }),
          ],
        };
      }

      const ocr = safeJson<OcrRecord[]>(row.attachmentOcr, []);
      const refs = safeJson<unknown[]>(row.attachmentRefs, []);
      const skips = safeJson<unknown[]>(row.attachmentSkips, []);

      // The events this email produced. `resulting_event_id` is singular — an
      // email that created six events records one — so this reports the column
      // AND says so, rather than implying it is the whole answer. The
      // one-to-many link table is OPE-464's scope.
      const resulting = row.resultingEventId
        ? await db
            .select({ id: events.id, name: events.name, slug: events.slug, status: events.status })
            .from(events)
            .where(eq(events.id, row.resultingEventId))
            .limit(1)
        : [];

      return {
        content: [
          jsonContent({
            id: row.id,
            received_at: row.receivedAt?.toISOString() ?? null,
            from_address: row.fromAddress,
            to_address: row.toAddress,
            subject: row.subject,
            intent: row.intent,
            status: row.status,
            reply_kind: row.replyKind,
            workflow_instance_id: row.workflowInstanceId,
            message_id: row.messageId,
            parsed_url: row.parsedUrl,
            // Stated explicitly because it is a live trap: the column is
            // SINGULAR. An email whose body carried four links records one.
            parsed_url_note:
              "inbound_emails.parsed_url stores ONE url. If the body carried several, the others are not on this row — check event_data_citations for the event this produced.",
            body_text: row.bodyText ?? row.bodyTextExcerpt ?? null,
            body_text_is_excerpt_only: !row.bodyText && !!row.bodyTextExcerpt,
            ...(params.include_body_html ? { body_html: row.bodyHtml } : {}),
            raw_size: row.rawSize,
            error: row.error,
            resulting_event_id: row.resultingEventId,
            resulting_event: resulting[0] ?? null,
            resulting_event_note:
              "Singular by schema — an email that created several events records only one here (OPE-464).",
            attachment_count: row.attachmentCount,
            attachment_refs: refs,
            attachment_skips: skips,
            attachment_ocr: ocr.map((o) => ({
              key: o.key,
              name: o.name,
              chars: o.chars,
              outcome: o.outcome,
              ...(params.include_ocr_text !== false ? { markdown: o.markdown } : {}),
            })),
            // OPE-409 — the previous wording read "it is not recoverable",
            // where "it" scans as THE ATTACHMENT. On 2026-08-21 an agent read it
            // that way, concluded a fair's official poster was unreachable, and
            // told John so — while the file sat in `attachment_refs` on this
            // same response. What is unrecoverable is the OCR TEXT.
            attachment_ocr_note:
              ocr.length === 0 && row.attachmentCount > 0
                ? "No OCR TEXT stored — discarded after extraction before OPE-499, and not regenerable. The ATTACHMENT ITSELF is retained: see attachment_refs[].key, and call fetch_inbound_attachment to read its bytes."
                : undefined,
          }),
        ],
      };
    }
  );

  // --- fetch_inbound_attachment --------------------------------------------
  //
  // OPE-409 step 2. The bytes of an inbound attachment have always been
  // reachable — anonymously, from the public CDN — and that is the exposure this
  // ticket exists to close. The moment it closes, the ONLY route is the
  // admin-gated `/api/admin/inbound-emails/[id]/attachments/[index]`, which
  // takes a browser session or the `X-Internal-Key` that only our own Workers
  // hold. Neither is callable by an agent holding an MCP token.
  //
  // So the lockdown cannot ship without this tool: closing the public path first
  // would trade a low-severity exposure for a real operational loss, namely the
  // ability to rescue photos the pipeline drops.
  //
  // Discoverability is part of the requirement, not a nicety. On 2026-08-21 an
  // agent working a live repair concluded a fair's official poster was
  // unrecoverable and told John so — the reasoning was "no MCP tool returns the
  // bytes", which was TRUE, and the conclusion was false, because the CDN was
  // serving it. A recovery path that only exists in a ticket gets rediscovered
  // the hard way. Hence this tool, and hence the `attachment_ocr_note` above
  // pointing straight at it.
  server.tool(
    "fetch_inbound_attachment",
    "Read the BYTES of one inbound-email attachment (poster, flyer, PDF) — base64, with its name and mime type. This is the authenticated recovery path: use it when an attachment's content matters and no OCR text was stored, and after the public inbound-attachments/ CDN prefix is closed. Get the index from get_inbound_email's attachment_refs. Read-only. Admin only.",
    {
      inbound_email_id: z.string().describe("inbound_emails.id"),
      index: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Position in attachment_refs, from get_inbound_email."),
    },
    async (params: { inbound_email_id: string; index: number }) => {
      if (!env?.INTERNAL_API_KEY && !env?.MAIN_APP) {
        return contentOf({
          ok: false,
          error: "unconfigured",
          detail:
            "Neither MAIN_APP binding nor INTERNAL_API_KEY is set on this Worker, so the authenticated attachment route cannot be reached.",
        });
      }

      let res: Response;
      try {
        res = await mainAppFetch(
          env,
          `/api/admin/inbound-emails/${encodeURIComponent(params.inbound_email_id)}/attachments/${params.index}`,
          "fetch"
        );
      } catch (err) {
        return contentOf({
          ok: false,
          error: "fetch-failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      if (!res.ok) {
        // Surface the real status. A 401 here means the internal key is wrong,
        // which is a deployment fault and must not read as "no such attachment".
        return contentOf({
          ok: false,
          error: `http-${res.status}`,
          detail:
            res.status === 401
              ? "The route rejected our internal key — a Worker configuration fault, not a missing attachment."
              : res.status === 404
                ? "No attachment at that index for that email."
                : await res.text().catch(() => ""),
        });
      }

      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const disposition = res.headers.get("content-disposition") ?? "";
      const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);

      // Base64 inflates by ~4/3, and a tool response has to survive being read
      // by a model. Above the cap, return the metadata and say plainly that the
      // bytes were withheld — a truncated base64 blob is worse than none,
      // because it decodes to a corrupt file that looks like a real answer.
      const MAX_INLINE_BYTES = 1_500_000;
      if (bytes.byteLength > MAX_INLINE_BYTES) {
        return contentOf({
          ok: true,
          inlined: false,
          reason: "too-large",
          size: bytes.byteLength,
          max_inline_bytes: MAX_INLINE_BYTES,
          content_type: contentType,
          filename: nameMatch?.[1] ?? null,
          note: "Bytes withheld, not truncated. For an image this size, replay_inbound_attachment (OCR/vision) is the cheaper read; a human can download it from /admin/inbound-emails.",
        });
      }

      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);

      return contentOf({
        ok: true,
        inlined: true,
        size: bytes.byteLength,
        content_type: contentType,
        filename: nameMatch?.[1] ?? null,
        base64: btoa(binary),
      });
    }
  );

  // --- list_inbound_emails -------------------------------------------------
  server.tool(
    "list_inbound_emails",
    "List inbound emails with filters — the measurement surface the 2026-08-18 pass had to do by hand. Filter by intent, status, reply_kind, sender, and a received-at window. Returns a summary row each (no bodies); use get_inbound_email for one in full. Read-only. Admin only.",
    {
      intent: z.string().optional().describe("e.g. 'submit', 'photo_intake'"),
      status: z.string().optional().describe("e.g. 'received', 'replied', 'failed'"),
      reply_kind: z
        .string()
        .optional()
        .describe("e.g. 'ok-multi', 'no-url', 'no-url-prose-failed'"),
      from_address: z.string().optional().describe("Exact or partial sender address."),
      received_after: z.string().optional().describe("ISO date/datetime, inclusive."),
      received_before: z.string().optional().describe("ISO date/datetime, inclusive."),
      has_attachments: z
        .boolean()
        .optional()
        .describe("Only emails that arrived with attachments."),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async (params) => {
      const conds = [];
      if (params.intent) conds.push(eq(inboundEmails.intent, params.intent));
      if (params.status) conds.push(eq(inboundEmails.status, params.status));
      if (params.reply_kind) conds.push(eq(inboundEmails.replyKind, params.reply_kind));
      if (params.from_address)
        conds.push(like(inboundEmails.fromAddress, `%${params.from_address}%`));
      if (params.received_after) {
        const d = new Date(params.received_after);
        if (!Number.isNaN(d.getTime())) conds.push(gte(inboundEmails.receivedAt, d));
      }
      if (params.received_before) {
        const d = new Date(params.received_before);
        if (!Number.isNaN(d.getTime())) conds.push(lte(inboundEmails.receivedAt, d));
      }

      const rows = await db
        .select({
          id: inboundEmails.id,
          receivedAt: inboundEmails.receivedAt,
          fromAddress: inboundEmails.fromAddress,
          toAddress: inboundEmails.toAddress,
          subject: inboundEmails.subject,
          intent: inboundEmails.intent,
          status: inboundEmails.status,
          replyKind: inboundEmails.replyKind,
          attachmentCount: inboundEmails.attachmentCount,
          attachmentOcr: inboundEmails.attachmentOcr,
          resultingEventId: inboundEmails.resultingEventId,
          error: inboundEmails.error,
        })
        .from(inboundEmails)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(inboundEmails.receivedAt))
        .limit(params.limit ?? 50);

      const filtered = params.has_attachments ? rows.filter((r) => r.attachmentCount > 0) : rows;

      return {
        content: [
          jsonContent({
            count: filtered.length,
            emails: filtered.map((r) => ({
              inbound_email_id: r.id,
              received_at: r.receivedAt?.toISOString() ?? null,
              from_address: r.fromAddress,
              to_address: r.toAddress,
              subject: r.subject,
              intent: r.intent,
              status: r.status,
              reply_kind: r.replyKind,
              attachment_count: r.attachmentCount,
              has_stored_ocr: !!r.attachmentOcr,
              resulting_event_id: r.resultingEventId,
              error: r.error,
            })),
          }),
        ],
      };
    }
  );

  // --- get_sent_emails -----------------------------------------------------
  server.tool(
    "get_sent_emails",
    "Read what we actually TOLD a submitter — the ledgered outbound side, including the rendered body. Filter by inbound_email_id, message_id, or recipient. Note this is different from list_pending_replies, which only shows replies the EMAIL_REPLY_ENABLED gate REFUSED to send; this shows what went out. Read-only. Admin only.",
    {
      inbound_email_id: z
        .string()
        .optional()
        .describe("Replies sent in response to this inbound email."),
      message_id: z.string().optional().describe("A specific ledger row."),
      recipient: z.string().optional().describe("Exact or partial recipient address."),
      include_body: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    async (params) => {
      const conds = [];
      if (params.inbound_email_id)
        conds.push(eq(emailSendLedger.inboundEmailId, params.inbound_email_id));
      if (params.message_id) conds.push(eq(emailSendLedger.messageId, params.message_id));
      if (params.recipient) conds.push(like(emailSendLedger.recipient, `%${params.recipient}%`));

      if (conds.length === 0) {
        return {
          content: [
            jsonContent({
              error: "filter_required",
              detail:
                "Pass inbound_email_id, message_id or recipient. An unfiltered dump of outbound mail is not a useful read and is a lot of contributor PII.",
            }),
          ],
        };
      }

      const rows = await db
        .select()
        .from(emailSendLedger)
        .where(and(...conds))
        .orderBy(desc(emailSendLedger.sentAt))
        .limit(params.limit ?? 20);

      return {
        content: [
          jsonContent({
            count: rows.length,
            sent: rows.map((r) => ({
              message_id: r.messageId,
              sent_at: r.sentAt?.toISOString() ?? null,
              recipient: r.recipient,
              subject: r.subject,
              source: r.source,
              provider: r.provider,
              status: r.status,
              delivery_status: r.deliveryStatus,
              delivery_detail: r.deliveryDetail,
              error: r.error,
              inbound_email_id: r.inboundEmailId,
              ...(params.include_body !== false
                ? { body_text: r.bodyText, body_html: r.bodyHtml }
                : {}),
            })),
          }),
        ],
      };
    }
  );

  // --- get_workflow_instance (OPE-501) -------------------------------------
  server.tool(
    "get_workflow_instance",
    "Open a Workflow run by its workflow_instance_id (or by inbound_email_id) — the identifier that was previously surfaced everywhere and accepted by nothing. Returns the live instance status from the Workflows binding PLUS the per-step record: which steps ran, which were SKIPPED and why, and the source list the pipeline fanned out over. Use this to tell 'the step ran and produced nothing' apart from 'the step never ran' — different defects with different fixes. Read-only. Admin only.",
    {
      workflow_instance_id: z.string().optional(),
      inbound_email_id: z
        .string()
        .optional()
        .describe("Resolve the run from the email that caused it."),
    },
    async (params) => {
      let instanceId = params.workflow_instance_id ?? null;
      let emailId = params.inbound_email_id ?? null;

      if (!instanceId && !emailId) {
        return {
          content: [jsonContent({ error: "workflow_instance_id_or_inbound_email_id_required" })],
          isError: true,
        };
      }

      // Resolve either direction (item 3).
      if (!instanceId && emailId) {
        const [row] = await db
          .select({ wf: inboundEmails.workflowInstanceId })
          .from(inboundEmails)
          .where(eq(inboundEmails.id, emailId))
          .limit(1);
        instanceId = row?.wf ?? null;
        if (!instanceId) {
          return {
            content: [
              jsonContent({
                error: "no_workflow_instance_for_email",
                inbound_email_id: emailId,
                detail:
                  "The email row carries no workflow_instance_id — it may predate the workflow, or never have been routed.",
              }),
            ],
            isError: true,
          };
        }
      }

      const steps = await db
        .select()
        .from(workflowRunSteps)
        .where(eq(workflowRunSteps.instanceId, instanceId as string))
        .orderBy(workflowRunSteps.recordedAt);

      if (!emailId) emailId = steps[0]?.inboundEmailId ?? null;

      // Live instance state from the binding. This is INSTANCE-level only —
      // Cloudflare's WorkflowInstance.status() returns { status, error?, output? }
      // and never per-step history, which is exactly why the steps above are
      // persisted rather than read back.
      let liveStatus: unknown = null;
      let liveStatusError: string | null = null;
      if (env?.INBOUND_EMAIL) {
        try {
          const inst = await env.INBOUND_EMAIL.get(instanceId as string);
          liveStatus = await inst.status();
        } catch (err) {
          liveStatusError = err instanceof Error ? err.message : String(err);
        }
      } else {
        liveStatusError = "INBOUND_EMAIL binding not available in this context";
      }

      const resulting = emailId
        ? await db
            .select({ id: events.id, name: events.name, slug: events.slug, status: events.status })
            .from(events)
            .where(
              eq(
                events.id,
                sql`(SELECT resulting_event_id FROM inbound_emails WHERE id = ${emailId})`
              )
            )
            .limit(1)
        : [];

      return {
        content: [
          jsonContent({
            workflow_instance_id: instanceId,
            inbound_email_id: emailId,
            live_status: liveStatus,
            live_status_error: liveStatusError,
            live_status_note:
              "Instance-level only. Cloudflare's WorkflowInstance.status() returns { status, error?, output? } and carries no per-step history; `steps` below is the persisted record.",
            step_count: steps.length,
            steps: steps.map((s2) => ({
              step: s2.stepName,
              status: s2.status,
              detail: s2.detail ? safeJson<unknown>(s2.detail, s2.detail) : null,
              duration_ms: s2.durationMs,
              recorded_at: s2.recordedAt?.toISOString() ?? null,
            })),
            steps_note:
              steps.length === 0
                ? "No step records. Runs before OPE-501 shipped are opaque — this is not backfillable."
                : undefined,
            resulting_event: resulting[0] ?? null,
          }),
        ],
      };
    }
  );
}
