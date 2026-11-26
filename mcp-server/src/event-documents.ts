/**
 * OPE-1580 — post a stored inbound attachment to an event page as a blank
 * vendor form, and withdraw one.
 *
 * Rules, from John's review: a person confirms the form is blank; the file is
 * copied to a new key and the `inbound-attachments/` original is never linked;
 * PDF, PNG and JPEG only, typed from the bytes; image metadata is stripped.
 */
import { and, eq } from "drizzle-orm";
import {
  eventDocumentExpiresAt,
  eventDocumentExtension,
  isEventDocumentMimeType,
  stripExifFromJpeg,
  stripPngMetadata,
  type EventDocumentKind,
} from "@takemetothefair/utils";
import { adminActions, eventDocuments, events, inboundEmails } from "./schema.js";
import type { Db } from "./db.js";
import { sniffAttachmentType } from "./attachment-sniff.js";
import type { AttachmentRef } from "./email-handler.js";

export const EVENT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export interface PostEventDocumentInput {
  eventId: string;
  inboundEmailId: string;
  attachmentIndex: number;
  kind: EventDocumentKind;
  displayName: string;
  sourceOrganizer: string;
  postedBy: string | null;
}

export type PostEventDocumentResult =
  | {
      ok: true;
      id: string;
      download_path: string;
      mime_type: string;
      size_bytes: number;
      expires_at: string;
      needs_review: boolean;
      warning?: string;
    }
  | { ok: false; error: string; detail: string };

const refuse = (error: string, detail: string): PostEventDocumentResult => ({
  ok: false,
  error,
  detail,
});

export async function postEventDocument(
  db: Db,
  bucket: R2Bucket,
  input: PostEventDocumentInput,
  now: Date = new Date()
): Promise<PostEventDocumentResult> {
  const [event] = await db
    .select({
      id: events.id,
      startDate: events.startDate,
      endDate: events.endDate,
      applicationUrl: events.applicationUrl,
      mergedInto: events.mergedInto,
    })
    .from(events)
    .where(eq(events.id, input.eventId))
    .limit(1);
  if (!event) return refuse("event-not-found", `No event ${input.eventId}.`);
  if (event.mergedInto) {
    return refuse("event-merged", `Event was merged into ${event.mergedInto}. Post it there.`);
  }
  const lastDay = event.endDate ?? event.startDate;
  if (!lastDay) return refuse("event-undated", "A form belongs to a dated event.");
  const expiresAt = eventDocumentExpiresAt(lastDay);
  if (expiresAt.getTime() <= now.getTime()) {
    return refuse("event-over", "The event has ended, so the form would never be shown.");
  }

  const [email] = await db
    .select({ attachmentRefs: inboundEmails.attachmentRefs, receivedAt: inboundEmails.receivedAt })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, input.inboundEmailId))
    .limit(1);
  if (!email) return refuse("email-not-found", `No inbound email ${input.inboundEmailId}.`);
  let refs: AttachmentRef[] = [];
  try {
    refs = JSON.parse(email.attachmentRefs ?? "[]") as AttachmentRef[];
  } catch {
    return refuse("bad-attachment-refs", "The email's attachment_refs could not be read.");
  }
  const ref = refs[input.attachmentIndex];
  if (!ref) {
    return refuse(
      "attachment-not-found",
      `The email has ${refs.length} stored attachments, none at index ${input.attachmentIndex}.`
    );
  }

  const [already] = await db
    .select({ id: eventDocuments.id })
    .from(eventDocuments)
    .where(
      and(
        eq(eventDocuments.eventId, input.eventId),
        eq(eventDocuments.sourceInboundEmailId, input.inboundEmailId),
        eq(eventDocuments.sourceAttachmentIndex, input.attachmentIndex),
        eq(eventDocuments.status, "live")
      )
    )
    .limit(1);
  if (already) return refuse("already-posted", `Already live as document ${already.id}.`);

  const object = await bucket.get(ref.key);
  if (!object) return refuse("file-missing", `Nothing stored at ${ref.key}.`);
  const source = new Uint8Array(await object.arrayBuffer());
  if (source.byteLength > EVENT_DOCUMENT_MAX_BYTES) {
    return refuse("too-large", `File is ${source.byteLength} bytes; the limit is 10 MB.`);
  }

  const mimeType = sniffAttachmentType(source);
  if (!isEventDocumentMimeType(mimeType)) {
    return refuse(
      "disallowed-type",
      `Only PDF, PNG and JPEG can be posted. This file's bytes read as ${mimeType ?? "unrecognized"}.`
    );
  }
  const bytes =
    mimeType === "image/jpeg"
      ? stripExifFromJpeg(source).bytes
      : mimeType === "image/png"
        ? stripPngMetadata(source).bytes
        : source;

  const id = crypto.randomUUID();
  const r2Key = `event-documents/${input.eventId}/${id}.${eventDocumentExtension(mimeType)}`;
  await bucket.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType, contentDisposition: "attachment" },
  });

  await db.insert(eventDocuments).values({
    id,
    eventId: input.eventId,
    r2Key,
    displayName: input.displayName,
    mimeType,
    sizeBytes: bytes.byteLength,
    kind: input.kind,
    year: lastDay.getUTCFullYear(),
    sourceOrganizer: input.sourceOrganizer,
    sourceInboundEmailId: input.inboundEmailId,
    sourceAttachmentIndex: input.attachmentIndex,
    receivedAt: email.receivedAt,
    postedBy: input.postedBy,
    postedAt: now,
    expiresAt,
  });
  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action: "event_document.posted",
    actorUserId: input.postedBy,
    targetType: "event",
    targetId: input.eventId,
    payloadJson: JSON.stringify({
      document_id: id,
      inbound_email_id: input.inboundEmailId,
      attachment_index: input.attachmentIndex,
      kind: input.kind,
    }),
    createdAt: now,
  });

  const needsReview = !!event.applicationUrl;
  return {
    ok: true,
    id,
    download_path: `/api/event-documents/${id}`,
    mime_type: mimeType,
    size_bytes: bytes.byteLength,
    expires_at: expiresAt.toISOString(),
    needs_review: needsReview,
    ...(needsReview
      ? {
          warning:
            "This event has an application_url. The organizer's own link wins: check it and withdraw this copy if it covers the form.",
        }
      : {}),
  };
}

export type WithdrawEventDocumentResult =
  | { ok: true; id: string; file_deleted: boolean; warning?: string }
  | { ok: false; error: string; detail: string };

export async function withdrawEventDocument(
  db: Db,
  bucket: R2Bucket,
  input: { documentId: string; reason: string; withdrawnBy: string | null },
  now: Date = new Date()
): Promise<WithdrawEventDocumentResult> {
  const [doc] = await db
    .select()
    .from(eventDocuments)
    .where(eq(eventDocuments.id, input.documentId))
    .limit(1);
  if (!doc) return { ok: false, error: "not-found", detail: `No document ${input.documentId}.` };
  if (doc.status === "withdrawn") {
    return { ok: false, error: "already-withdrawn", detail: `Withdrawn: ${doc.withdrawnReason}` };
  }

  // The row goes first: it is what the page and the download route read, so
  // the form stops serving even if the delete below fails.
  await db
    .update(eventDocuments)
    .set({ status: "withdrawn", withdrawnReason: input.reason, withdrawnAt: now })
    .where(eq(eventDocuments.id, doc.id));
  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action: "event_document.withdrawn",
    actorUserId: input.withdrawnBy,
    targetType: "event",
    targetId: doc.eventId,
    payloadJson: JSON.stringify({ document_id: doc.id, reason: input.reason }),
    createdAt: now,
  });

  try {
    await bucket.delete(doc.r2Key);
    return { ok: true, id: doc.id, file_deleted: true };
  } catch (err) {
    return {
      ok: true,
      id: doc.id,
      file_deleted: false,
      warning: `The form no longer serves, but deleting ${doc.r2Key} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
