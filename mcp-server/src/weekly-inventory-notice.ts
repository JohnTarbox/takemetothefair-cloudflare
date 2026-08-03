/**
 * OPE-308 (alert diet E2) — one Monday inventory email instead of daily ones.
 *
 * Measured on 2026-08-03 from `email_send_ledger` (30d): the operator received
 * automation mail on essentially every single day — promoter-enrichment 22/22,
 * roster-research 16/16, plus the goodwill canary and two others. Individually
 * each was defensible; together they were a daily stream nobody could act on,
 * which is how a channel stops being read.
 *
 * Inventories answer "how big is the backlog" — a question with a weekly
 * rhythm, not a daily one. So they fold into a single Monday summary carrying
 * the count AND the week-over-week delta, which is the part that actually tells
 * an operator whether to care.
 *
 * SCOPE, deliberately narrower than the ticket in one place: the goodwill
 * canary's THRESHOLD ALARM is left intact. The ticket lists "goodwill queue
 * count" among the inventories to fold, and its open count does appear below —
 * but that sender is a conditional RED/YELLOW growth alarm, and it fired 23/23
 * days only because the OPE-305 duplicate explosion made the queue grow every
 * single day. With that fixed (7,193 → 199 open) it should fall quiet on its
 * own. Folding it away would delete a working alarm to solve a problem that no
 * longer exists. Reported here as inventory; still able to shout on real growth.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { events, promoters, eventDiscrepancies } from "./schema.js";
import type { Env } from "./index.js";
import { getDb, type Db } from "./db.js";
import { logError } from "./logger.js";
import { weeklyInventoryState } from "./schema.js";

const SOURCE = "mcp:schedule:weekly-inventory";
const STATE_KEY = "default";

/** Monday. `getUTCDay()` is 0=Sunday, so Monday is 1. */
const MONDAY = 1;

export interface InventoryCounts {
  rosterResearch: number;
  promoterEnrichment: number;
  goodwillOpen: number;
}

/**
 * The three backlog counts. Predicates mirror the daily notices they replace —
 * deliberately the SAME conditions, so the weekly number is comparable with
 * what the operator has been reading, not a subtly different one.
 */
export async function readInventoryCounts(db: Db): Promise<InventoryCounts> {
  const [roster, promoter, goodwill] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(
        and(
          eq(events.lifecycleStatus, "OCCURRED"),
          isNull(events.mergedInto),
          eq(events.vendorRosterStatus, "NEEDS_RESEARCH")
        )
      ),
    db
      .select({ n: sql<number>`count(*)` })
      .from(promoters)
      .where(eq(promoters.enrichmentStatus, "NEEDS_ENRICHMENT")),
    db
      .select({ n: sql<number>`count(*)` })
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.resolutionStatus, "open")),
  ]);
  return {
    rosterResearch: roster[0]?.n ?? 0,
    promoterEnrichment: promoter[0]?.n ?? 0,
    goodwillOpen: goodwill[0]?.n ?? 0,
  };
}

/** `+12` / `-3` / `±0` — the delta is the part worth reading. */
export function formatDelta(current: number, prior: number | null): string {
  if (prior === null) return "—";
  const d = current - prior;
  if (d === 0) return "±0";
  return d > 0 ? `+${d}` : `${d}`;
}

/**
 * Should this run send? Monday only, and at most once per Monday.
 *
 * Date-keyed rather than "has 7 days elapsed" so a missed week doesn't shift
 * the cadence permanently — the operator gets Monday mail on Mondays.
 */
export function decideWeeklyInventory(today: Date, lastSentDate: string | null): boolean {
  if (today.getUTCDay() !== MONDAY) return false;
  return lastSentDate !== today.toISOString().slice(0, 10);
}

// Takes the worker `Env` directly, matching the sibling notices it replaces —
// the queue binding's message type is the union of every email job, so a local
// structural type would either couple this module to all of them or need a cast.
export async function runWeeklyInventoryNotice(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  let prior: { lastSentDate: string | null; counts: InventoryCounts | null } = {
    lastSentDate: null,
    counts: null,
  };
  try {
    const row = await db.query.weeklyInventoryState.findFirst({
      where: eq(weeklyInventoryState.id, STATE_KEY),
    });
    if (row) {
      prior = {
        lastSentDate: row.lastSentDate,
        counts: {
          rosterResearch: row.rosterResearchCount ?? 0,
          promoterEnrichment: row.promoterEnrichmentCount ?? 0,
          goodwillOpen: row.goodwillOpenCount ?? 0,
        },
      };
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[weekly-inventory] state read failed",
      error,
    });
    return;
  }

  if (!decideWeeklyInventory(today, prior.lastSentDate)) {
    console.log(
      `[cron] weekly-inventory skip — day=${today.getUTCDay()} lastSent=${prior.lastSentDate ?? "never"}`
    );
    return;
  }

  let counts: InventoryCounts;
  try {
    counts = await readInventoryCounts(db);
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[weekly-inventory] count queries failed",
      error,
    });
    return;
  }

  const rows: { label: string; current: number; prior: number | null; href: string }[] = [
    {
      label: "Vendor-roster research",
      current: counts.rosterResearch,
      prior: prior.counts?.rosterResearch ?? null,
      href: "https://meetmeatthefair.com/admin/events",
    },
    {
      label: "Promoter enrichment",
      current: counts.promoterEnrichment,
      prior: prior.counts?.promoterEnrichment ?? null,
      href: "https://meetmeatthefair.com/admin/promoters",
    },
    {
      label: "Goodwill queue (open)",
      current: counts.goodwillOpen,
      prior: prior.counts?.goodwillOpen ?? null,
      href: "https://meetmeatthefair.com/admin/data-health",
    },
  ];

  const total = counts.rosterResearch + counts.promoterEnrichment + counts.goodwillOpen;
  const subject = `📋 MMATF Monday inventory — ${total} open across 3 queues`;
  const textBody =
    `Backlog as of ${todayIso} (Δ vs last Monday):\n\n` +
    rows.map((r) => ` • ${r.label}: ${r.current} (${formatDelta(r.current, r.prior)})`).join("\n") +
    `\n\nThis replaces the daily queue notices — alarms still push on condition.\n`;
  const htmlBody =
    `<p><strong>📋 MMATF Monday inventory</strong> — backlog as of ${todayIso}.</p>` +
    `<table cellpadding="6" style="border-collapse:collapse">` +
    `<tr><th align="left">Queue</th><th align="right">Open</th><th align="right">Δ week</th></tr>` +
    rows
      .map(
        (r) =>
          `<tr><td><a href="${r.href}">${r.label}</a></td>` +
          `<td align="right"><strong>${r.current}</strong></td>` +
          `<td align="right">${formatDelta(r.current, r.prior)}</td></tr>`
      )
      .join("") +
    `</table>` +
    `<p style="color:#666;font-size:12px">Replaces the daily queue notices. Alarms still push on condition.</p>`;

  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  if (alertEmail && env.EMAIL_JOBS) {
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: "weekly-inventory",
      });
      console.log(`[cron] weekly-inventory sent — total=${total} to=${alertEmail}`);
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: "[weekly-inventory] email enqueue failed",
        error,
        context: { counts },
      });
      // Do NOT stamp state on a failed send — next Monday's run should retry
      // rather than silently skip a week.
      return;
    }
  } else {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: `[weekly-inventory] would send (total=${total}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
    });
  }

  try {
    await db
      .insert(weeklyInventoryState)
      .values({
        id: STATE_KEY,
        lastSentDate: todayIso,
        rosterResearchCount: counts.rosterResearch,
        promoterEnrichmentCount: counts.promoterEnrichment,
        goodwillOpenCount: counts.goodwillOpen,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: weeklyInventoryState.id,
        set: {
          lastSentDate: todayIso,
          rosterResearchCount: counts.rosterResearch,
          promoterEnrichmentCount: counts.promoterEnrichment,
          goodwillOpenCount: counts.goodwillOpen,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[weekly-inventory] state write failed — next Monday may resend",
      error,
    });
  }
}
