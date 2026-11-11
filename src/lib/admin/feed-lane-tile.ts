/**
 * OPE-1632 — the /admin dashboard's "Organizer feeds" tile.
 *
 * The numbers come from `loadFeedLaneMetrics` (packages/db-schema), the same
 * function behind the MCP tool `get_feed_lane_metrics` and the daily digest's
 * feeds line, so the three cannot disagree. This file only shapes them for the
 * card. A failed read returns null, and the card shows "—", never 0.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  FEED_REVIEW_TARGET_DAYS,
  loadFeedLaneMetrics,
  type FeedLaneMetrics,
} from "@takemetothefair/db-schema";
import type * as schema from "@/lib/db/schema";
import { publicEventWhere } from "@/lib/event-lifecycle";
import { logError } from "@/lib/logger";

type Db = DrizzleD1Database<typeof schema>;

export interface FeedLaneTile {
  feedsEnabled: number;
  feedsHealthy: number;
  /** Funnel bar segments over items read in the window; they sum to `read`. */
  read: number;
  matched: number;
  fresh: number;
  dropped: number;
  awaitingReview: number;
  oldestAgeDays: number | null;
  /** True when any backlog item is older than the target: the red marker. */
  pastTarget: boolean;
  targetDays: number;
  /** 0..1, or null when there is no upcoming public event. */
  coverageHealthyShare: number | null;
  newToUs7d: number;
  windowDays: number;
}

const stepCount = (m: FeedLaneMetrics, step: string): number =>
  m.total.funnel.steps.find((s) => s.step === step)?.count ?? 0;

/** Pure — exported for tests. */
export function toFeedLaneTile(m: FeedLaneMetrics): FeedLaneTile {
  const b = m.total.backlog;
  return {
    feedsEnabled: m.feeds.enabled,
    feedsHealthy: m.feeds.healthy,
    read: stepCount(m, "read"),
    matched: stepCount(m, "matched"),
    fresh: stepCount(m, "new"),
    dropped: stepCount(m, "dropped"),
    awaitingReview: b.awaiting_review.value ?? 0,
    oldestAgeDays: b.oldest_age_days.value,
    pastTarget: (b.older_than_target.value ?? 0) > 0,
    targetDays: b.target_days,
    coverageHealthyShare: m.coverage.share_with_healthy_feed.value,
    newToUs7d: m.coverage.new_to_us_7d.value ?? 0,
    windowDays: m.window.days,
  };
}

export async function loadFeedLaneTile(db: Db, now: Date): Promise<FeedLaneTile | null> {
  try {
    const m = await loadFeedLaneMetrics(db, {
      now,
      publicWhere: publicEventWhere(),
      windowDays: 30,
      targetDays: FEED_REVIEW_TARGET_DAYS,
    });
    return toFeedLaneTile(m);
  } catch (error) {
    await logError(db, {
      message: "Feed lane tile read failed",
      error,
      source: "lib/admin/feed-lane-tile.ts",
    });
    return null;
  }
}

/** "<1d" under a day, otherwise whole days; "—" when there is no backlog. */
export function formatFeedAge(days: number | null): string {
  if (days == null) return "—";
  return days < 1 ? "<1d" : `${Math.floor(days)}d`;
}
