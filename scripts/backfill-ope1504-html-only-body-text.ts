/**
 * OPE-1504 — one-shot backfill: give the existing HTML-only inbound rows the
 * body_text the capture path now derives at ingest.
 *
 * Follows docs/bulk-mutation-discipline.md:
 *   - single-writer: one operator run, 7 rows at time of writing.
 *   - idempotent: every UPDATE re-checks the target predicate, so a re-run
 *     changes 0 rows.
 *   - read-back-verified: re-run the SELECT below; expect 0 rows, except rows
 *     whose HTML has no visible text (left NULL on purpose).
 *   - rollback-planned: the ROLLBACK statement below.
 *
 * It does NOT re-run any workflow: no new acks, no re-classification. It only
 * fills text columns that are NULL.
 *
 * Usage: dump the target rows as JSON, then generate the per-row UPDATEs:
 *
 *   SELECT id, body_html FROM inbound_emails
 *   WHERE (body_text IS NULL OR body_text = '')
 *     AND body_html IS NOT NULL AND body_html <> '' AND capture_meta IS NULL;
 *
 *   npx tsx scripts/backfill-ope1504-html-only-body-text.ts rows.json > updates.json
 *
 * Each output entry is { sql, params } for a parameterised D1 query.
 *
 * ROLLBACK (restores the pre-backfill NULLs on exactly the rows it touched):
 *
 *   UPDATE inbound_emails SET body_text = NULL, body_text_excerpt = NULL, capture_meta = NULL
 *   WHERE capture_meta = '{"body_text_source":"html"}' AND id IN (<ids from updates.json>);
 *
 * Keep the id list: rows captured AFTER the deploy carry the same capture_meta
 * legitimately, and a rollback without the id list would erase theirs too.
 */
import { readFileSync } from "node:fs";
import { htmlToPlainText } from "@takemetothefair/utils";

// Same caps as mcp-server/src/email-handler.ts (MAX_BODY_LEN / BODY_EXCERPT_LEN).
const MAX_BODY_LEN = 50_000;
const BODY_EXCERPT_LEN = 500;

const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
  id: string;
  body_html: string;
}[];

const out = rows.flatMap((r) => {
  const text = htmlToPlainText(r.body_html).slice(0, MAX_BODY_LEN);
  if (!text) return []; // no visible text: leave NULL, as ingest would
  return [
    {
      sql:
        "UPDATE inbound_emails SET body_text = ?, body_text_excerpt = ?, " +
        'capture_meta = \'{"body_text_source":"html"}\' ' +
        "WHERE id = ? AND (body_text IS NULL OR body_text = '') AND capture_meta IS NULL",
      params: [text, text.slice(0, BODY_EXCERPT_LEN), r.id],
    },
  ];
});

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
