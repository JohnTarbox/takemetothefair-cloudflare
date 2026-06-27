/**
 * A12 — first-run backfill for the GSC/GA4 time-series tables.
 *
 * Walks ~16 months (GSC's max retention) in 30-day windows and POSTs each
 * window to the `/api/admin/analytics/gsc-metrics/sync` endpoint, which upserts
 * `gsc_search_metrics` + `ga4_daily_metrics`. Chunking keeps each request inside
 * Worker CPU/time limits and the GSC 25k-rows/response cap. Idempotent — the
 * endpoint upserts, so a re-run (or an overlap with the daily cron) is a no-op
 * on already-present rows.
 *
 * Usage:
 *   INTERNAL_API_KEY=... npx tsx scripts/gsc-backfill.ts
 *   BASE_URL=https://meetmeatthefair.com INTERNAL_API_KEY=... MONTHS=16 npx tsx scripts/gsc-backfill.ts
 *
 * Run against local first (BASE_URL=http://localhost:3000) to smoke it.
 */

// Force module scope (this script has no imports) so its top-level `main`/
// helpers don't collide with other global-scope scripts under `tsc`.
export {};

const BASE_URL = process.env.BASE_URL || "https://meetmeatthefair.com";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const MONTHS = Number(process.env.MONTHS || 16);
const WINDOW_DAYS = 30;
const LAG_DAYS = 3; // GSC reporting lag — newest reliable date is today-3

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function syncWindow(startDate: string, endDate: string) {
  const res = await fetch(`${BASE_URL}/api/admin/analytics/gsc-metrics/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": INTERNAL_API_KEY ?? "",
    },
    body: JSON.stringify({ start_date: startDate, end_date: endDate }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as {
    ok: boolean;
    gsc: { upserted: number; error: string | null };
    ga4: { upserted: number; error: string | null };
  };
}

async function main() {
  if (!INTERNAL_API_KEY) {
    console.error("Missing INTERNAL_API_KEY env var.");
    process.exit(1);
  }
  const totalDays = MONTHS * 30;
  let gscTotal = 0;
  let ga4Total = 0;
  console.log(`Backfilling ~${MONTHS} months against ${BASE_URL} in ${WINDOW_DAYS}-day windows…`);

  // Walk from oldest to newest so partial progress is chronological.
  for (let offset = totalDays; offset > LAG_DAYS; offset -= WINDOW_DAYS) {
    const startDate = isoDaysAgo(offset);
    const endDate = isoDaysAgo(Math.max(LAG_DAYS, offset - WINDOW_DAYS + 1));
    try {
      const r = await syncWindow(startDate, endDate);
      gscTotal += r.gsc.upserted;
      ga4Total += r.ga4.upserted;
      console.log(
        `  ${startDate} → ${endDate}: gsc=${r.gsc.upserted} ga4=${r.ga4.upserted}` +
          (r.gsc.error ? ` GSC_ERR=${r.gsc.error}` : "") +
          (r.ga4.error ? ` GA4_ERR=${r.ga4.error}` : "")
      );
    } catch (e) {
      console.error(`  ${startDate} → ${endDate}: FAILED — ${e instanceof Error ? e.message : e}`);
    }
    // Be polite to the GSC quota between windows.
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(
    `\nDone. gsc_search_metrics upserts=${gscTotal}, ga4_daily_metrics upserts=${ga4Total}`
  );
}

main();
