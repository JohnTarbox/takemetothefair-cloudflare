/**
 * OPE-50 — store for imported Bing Webmaster Tools "Referring Domains" CSV
 * snapshots. Bing's API exposes NO backlink data (GetLinkCounts / GetUrlLinks /
 * GetConnectedPages all live-probed empty 2026-07-02), so the operator exports
 * the BWT "Referring Domains" report and imports it here. The admin Bing tab and
 * the repurposed `get_bing_backlinks` reader surface the most-recent snapshot.
 *
 * Bulk import follows docs/bulk-mutation-discipline.md: single-writer (one admin
 * route invocation), idempotent (upsert on the (referring_domain, snapshot_date)
 * identity), chunked under the D1 100 bound-param cap.
 */
import type { Database } from "@/lib/db";
import { bingBacklinks } from "@/lib/db/schema";
import { desc, asc, eq, sql } from "drizzle-orm";

export interface ParsedReferringDomain {
  domain: string;
  count: number;
}

/**
 * Normalise a "Domain" cell (a full URL) to a bare host: lowercase, strip the
 * `http(s)://` scheme, strip a leading `www.`, strip a trailing slash (and any
 * path). Returns "" for input that yields no host.
 */
export function normaliseReferringDomain(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host === "") return "";
  host = host.replace(/^https?:\/\//, "");
  // Drop any path / query / fragment — keep only the host portion.
  host = host.split(/[/?#]/)[0] ?? "";
  host = host.replace(/^www\./, "");
  host = host.replace(/\/+$/, "");
  return host;
}

/**
 * Parse the BWT "Referring Domains" CSV: a header row (`"Domain","Backlinks
 * Count"`) followed by quoted rows. Robust to CRLF, a UTF-8 BOM, and a trailing
 * newline. Normalises each domain to a bare host; coerces the count via Number.
 * Skips the header, blank lines, and malformed rows (no host / non-finite count).
 */
export function parseReferringDomainsCsv(csv: string): ParsedReferringDomain[] {
  if (!csv) return [];
  // Strip a leading UTF-8 BOM, then split on CRLF or LF.
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  const out: ParsedReferringDomain[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const cells = parseCsvLine(line);
    if (cells.length < 2) continue;
    const rawDomain = cells[0] ?? "";
    const rawCount = cells[1] ?? "";
    // Skip the header row.
    if (rawDomain.trim().toLowerCase() === "domain") continue;
    const domain = normaliseReferringDomain(rawDomain);
    if (domain === "") continue;
    const count = Number(rawCount.trim());
    if (!Number.isFinite(count)) continue;
    out.push({ domain, count });
  }
  return out;
}

/**
 * Parse a single CSV line into cells, honouring double-quoted fields and the
 * `""` escaped-quote convention. The BWT export quotes every field.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// D1 bound-parameter cap is 100. Each row binds 3 columns (referring_domain,
// backlink_count, snapshot_date; id/created_at use column $defaultFns), so
// 30 rows × 3 = 90 params stays safely under the cap.
const IMPORT_CHUNK_ROWS = 30;

/**
 * Upsert referring-domain rows for a snapshot date. Idempotent on the
 * (referring_domain, snapshot_date) identity — re-importing the same snapshot
 * updates counts in place rather than duplicating. Later rows for the same
 * domain within one call win (last-write). Returns the number of rows imported.
 */
export async function importReferringDomains(
  db: Database,
  rows: ParsedReferringDomain[],
  snapshotDate: string
): Promise<{ imported: number }> {
  // Collapse duplicate domains within a single import (last value wins) so a
  // chunk boundary can't leave an earlier value stranded.
  const byDomain = new Map<string, number>();
  for (const r of rows) {
    if (!r.domain) continue;
    byDomain.set(r.domain, r.count);
  }
  const deduped = Array.from(byDomain, ([domain, count]) => ({ domain, count }));
  if (deduped.length === 0) return { imported: 0 };

  for (let i = 0; i < deduped.length; i += IMPORT_CHUNK_ROWS) {
    const chunk = deduped.slice(i, i + IMPORT_CHUNK_ROWS);
    await db
      .insert(bingBacklinks)
      .values(
        chunk.map((r) => ({
          referringDomain: r.domain,
          backlinkCount: r.count,
          snapshotDate,
        }))
      )
      .onConflictDoUpdate({
        target: [bingBacklinks.referringDomain, bingBacklinks.snapshotDate],
        set: { backlinkCount: sql`excluded.backlink_count` },
      });
  }
  return { imported: deduped.length };
}

export interface ReferringDomainRow {
  domain: string;
  count: number;
  snapshotDate: string;
}

/**
 * Return the rows from the MOST RECENT snapshot_date, ordered by backlink_count
 * DESC then domain ASC. Empty array when nothing has been imported.
 */
export async function getLatestReferringDomains(db: Database): Promise<ReferringDomainRow[]> {
  const [latest] = await db
    .select({ snapshotDate: bingBacklinks.snapshotDate })
    .from(bingBacklinks)
    .orderBy(desc(bingBacklinks.snapshotDate))
    .limit(1);
  if (!latest) return [];

  const rows = await db
    .select({
      domain: bingBacklinks.referringDomain,
      count: bingBacklinks.backlinkCount,
      snapshotDate: bingBacklinks.snapshotDate,
    })
    .from(bingBacklinks)
    .where(eq(bingBacklinks.snapshotDate, latest.snapshotDate))
    .orderBy(desc(bingBacklinks.backlinkCount), asc(bingBacklinks.referringDomain));

  return rows;
}
