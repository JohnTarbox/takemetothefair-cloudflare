/**
 * OPE-156 — the full inbound body columns (inbound_emails.body_text /
 * body_html, drizzle/0158). The email handler captures the whole parsed body
 * at ingest; the admin viewer reads it back via /api/admin/inbound-emails/[id].
 * These pin the round-trip: a >500-char body persists in full while the
 * body_text_excerpt preview stays capped, and pre-OPE-156 rows (null body)
 * degrade gracefully to the excerpt.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inboundEmails } from "../src/schema.js";
import { createTestDb, type TestDb } from "./setup-db.js";

let db: TestDb;
beforeEach(() => {
  db = createTestDb().db;
});

const EXCERPT_LEN = 500;

async function insertRow(values: {
  id: string;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyTextExcerpt: string | null;
}) {
  const now = new Date();
  await db.insert(inboundEmails).values({
    id: values.id,
    receivedAt: now,
    fromAddress: "carol@example.com",
    toAddress: "submit@meetmeatthefair.com",
    subject: "A long inquiry",
    intent: "submit",
    status: "received",
    workflowInstanceId: null,
    bodyTextExcerpt: values.bodyTextExcerpt,
    bodyText: values.bodyText,
    bodyHtml: values.bodyHtml,
    parsedUrl: null,
    attachmentCount: 0,
    rawSize: 70_000,
    error: null,
    messageId: null,
    createdAt: now,
  });
}

describe("inbound_emails full body columns (OPE-156)", () => {
  it("persists a body far longer than the 500-char excerpt, both parts", async () => {
    const longText = "T".repeat(3000);
    const longHtml = `<p>${"H".repeat(3000)}</p>`;
    await insertRow({
      id: "row-long",
      bodyText: longText,
      bodyHtml: longHtml,
      bodyTextExcerpt: longText.slice(0, EXCERPT_LEN),
    });

    const [row] = await db
      .select({
        bodyText: inboundEmails.bodyText,
        bodyHtml: inboundEmails.bodyHtml,
        bodyTextExcerpt: inboundEmails.bodyTextExcerpt,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, "row-long"));

    // Full body round-trips untruncated…
    expect(row.bodyText).toBe(longText);
    expect(row.bodyText?.length).toBe(3000);
    expect(row.bodyHtml).toBe(longHtml);
    // …while the list-view preview stays capped at 500.
    expect(row.bodyTextExcerpt?.length).toBe(EXCERPT_LEN);
  });

  it("a pre-OPE-156 row (null body) keeps only the excerpt", async () => {
    await insertRow({
      id: "row-legacy",
      bodyText: null,
      bodyHtml: null,
      bodyTextExcerpt: "opening line only",
    });

    const [row] = await db
      .select({
        bodyText: inboundEmails.bodyText,
        bodyHtml: inboundEmails.bodyHtml,
        bodyTextExcerpt: inboundEmails.bodyTextExcerpt,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, "row-legacy"));

    expect(row.bodyText).toBeNull();
    expect(row.bodyHtml).toBeNull();
    expect(row.bodyTextExcerpt).toBe("opening line only");
  });
});
