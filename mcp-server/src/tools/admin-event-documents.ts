/**
 * OPE-1580 — post, withdraw and list blank vendor forms on event pages.
 * See ../event-documents.ts. Admin only, and never run automatically.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { EVENT_DOCUMENT_KINDS, isEventDocumentLive } from "@takemetothefair/utils";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { eventDocuments, events } from "../schema.js";
import { postEventDocument, withdrawEventDocument } from "../event-documents.js";

const NO_BUCKET = {
  content: [jsonContent({ ok: false, error: "VENDOR_ASSETS binding is not available" })],
  isError: true,
};

export function registerEventDocumentTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: { VENDOR_ASSETS?: R2Bucket }
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "post_event_document",
    [
      "Publish a stored inbound attachment on an event's public page as a blank vendor form.",
      "Only for a person who has opened the file and confirmed it is BLANK: inbound attachments",
      "include filled-in applications with personal and payment details. Never call this from",
      "a scheduled or unattended run. PDF, PNG and JPEG only. The form stops serving after the",
      "event's end date. If the event has an application_url, the result is marked for review.",
      "Admin only.",
    ].join(" "),
    {
      event_id: z.string().min(1).describe("events.id of the dated event this form is for."),
      inbound_email_id: z.string().min(1).describe("inbound_emails.id holding the attachment."),
      attachment_index: z
        .number()
        .int()
        .min(0)
        .describe("Position in attachment_refs, from get_inbound_email."),
      kind: z.enum(EVENT_DOCUMENT_KINDS),
      display_name: z
        .string()
        .min(1)
        .max(120)
        .transform(decodeHtmlEntities)
        .describe('Public name, e.g. "Vendor application". No file extension.'),
      source_organizer: z
        .string()
        .min(1)
        .max(120)
        .transform(decodeHtmlEntities)
        .describe('Who issued the form, as shown publicly: "Received from <this>, <month year>".'),
      confirmed_blank: z
        .literal(true)
        .describe("Must be true. A person has opened this file and confirmed it is blank."),
    },
    async (params) => {
      if (!env?.VENDOR_ASSETS) return NO_BUCKET;
      const result = await postEventDocument(db, env.VENDOR_ASSETS, {
        eventId: params.event_id,
        inboundEmailId: params.inbound_email_id,
        attachmentIndex: params.attachment_index,
        kind: params.kind,
        displayName: params.display_name,
        sourceOrganizer: params.source_organizer,
        postedBy: auth.userId ?? null,
      });
      return { content: [jsonContent(result)], ...(result.ok ? {} : { isError: true }) };
    }
  );

  server.tool(
    "withdraw_event_document",
    "Take a posted vendor form off its event page and delete its file. It stops serving on the next request. Use when an organizer asks, or when the organizer's own link covers it. Admin only.",
    {
      document_id: z.string().min(1).describe("event_documents.id, from list_event_documents."),
      reason: z.string().min(1).max(500).transform(decodeHtmlEntities),
    },
    async (params) => {
      if (!env?.VENDOR_ASSETS) return NO_BUCKET;
      const result = await withdrawEventDocument(db, env.VENDOR_ASSETS, {
        documentId: params.document_id,
        reason: params.reason,
        withdrawnBy: auth.userId ?? null,
      });
      return { content: [jsonContent(result)], ...(result.ok ? {} : { isError: true }) };
    }
  );

  server.tool(
    "list_event_documents",
    "List vendor forms posted to event pages, newest first. `needs_review` means the event now has an application_url, so the organizer's own link may cover the form. Admin only.",
    {
      event_id: z.string().min(1).optional().describe("Limit to one event."),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async (params) => {
      const query = db
        .select({ doc: eventDocuments, applicationUrl: events.applicationUrl })
        .from(eventDocuments)
        .innerJoin(events, eq(events.id, eventDocuments.eventId));
      const rows = await (
        params.event_id ? query.where(eq(eventDocuments.eventId, params.event_id)) : query
      )
        .orderBy(desc(eventDocuments.postedAt))
        .limit(params.limit);
      const now = new Date();
      return {
        content: [
          jsonContent({
            count: rows.length,
            documents: rows.map(({ doc, applicationUrl }) => {
              const live = isEventDocumentLive(doc, now);
              return {
                id: doc.id,
                event_id: doc.eventId,
                display_name: doc.displayName,
                kind: doc.kind,
                year: doc.year,
                mime_type: doc.mimeType,
                size_bytes: doc.sizeBytes,
                source_organizer: doc.sourceOrganizer,
                source_inbound_email_id: doc.sourceInboundEmailId,
                posted_at: doc.postedAt.toISOString(),
                expires_at: doc.expiresAt.toISOString(),
                status: doc.status,
                live,
                needs_review: live && !!applicationUrl,
                withdrawn_reason: doc.withdrawnReason,
                download_path: `/api/event-documents/${doc.id}`,
              };
            }),
          }),
        ],
      };
    }
  );
}
