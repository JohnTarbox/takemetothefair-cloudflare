// @vitest-environment node
/**
 * OPE-1626 — the `feed-reader` heartbeat probe (per-feed staleness) and the
 * FAM-FEED-READ-FAILED fault family, on the real 0406–0413 DDL (the MCP
 * harness) and the real message the reader writes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../mcp-server/__tests__/setup-db";
import {
  FEED_READER_WINDOW_HOURS,
  HEARTBEAT_PROBES,
  assessHeartbeatSilence,
  feedReaderEvidence,
} from "@/lib/heartbeat";
import { classifyFault } from "@/lib/faults/family-registry";
import { normalizeErrorClass } from "@/lib/faults/signature";
import { FEED_READ_FAILED_FAULT } from "../../../mcp-server/src/feeds/run";

const H = 3_600_000;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

let db: ReturnType<typeof createTestDb>["db"];
let raw: Database.Database;
const probe = HEARTBEAT_PROBES.find((p) => p.name === "feed-reader")!;

function feed(
  id: string,
  o: { lastOkAgoH: number | null; createdAgoH: number; intervalH: number; enabled?: boolean }
) {
  const now = Date.now();
  raw
    .prepare(
      `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, poll_interval_hours, last_ok_at, created_at, updated_at)
       VALUES (?, 'p1', ?, 'ical', ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      `https://example.org/${id}.ics`,
      o.enabled === false ? 0 : 1,
      o.intervalH,
      o.lastOkAgoH === null ? null : secs(new Date(now - o.lastOkAgoH * H)),
      secs(new Date(now - o.createdAgoH * H)),
      secs(new Date(now))
    );
}
const red = async () =>
  assessHeartbeatSilence(
    {
      probe,
      enabledAt: new Date("2026-11-11T00:00:00Z"),
      lastEvidenceAt: await probe.lastEvidenceAt(db as never),
    },
    new Date()
  );

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p1','P','p','https://example.org')"
    )
    .run();
});

describe("feed-reader probe", () => {
  it("is registered with its 1h deadline window", () => {
    expect(probe).toBeDefined();
    expect(probe.expectedWindowHours).toBe(FEED_READER_WINDOW_HOURS);
  });

  it("no enabled feed reads healthy", async () => {
    expect(await red()).toBeNull();
    feed("off", { lastOkAgoH: 1000, createdAgoH: 2000, intervalH: 6, enabled: false });
    expect(await red()).toBeNull();
  });

  it("goes red for a feed with no good read within 2x its own interval, and only then", async () => {
    // landmark: fresh feeds are green
    feed("f6", { lastOkAgoH: 3, createdAgoH: 100, intervalH: 6 });
    feed("f24", { lastOkAgoH: 40, createdAgoH: 100, intervalH: 24 }); // 40 < 48
    expect(await red()).toBeNull();

    // 13h since the last good read of a 6h feed: past 12h → red
    raw
      .prepare("UPDATE promoter_event_feeds SET last_ok_at = ? WHERE id = 'f6'")
      .run(secs(new Date(Date.now() - 13 * H)));
    const r = await red();
    expect(r).not.toBeNull();
    expect(r!.refKey).toBe("heartbeat:feed-reader");

    // 11h is inside the deadline again
    raw
      .prepare("UPDATE promoter_event_feeds SET last_ok_at = ? WHERE id = 'f6'")
      .run(secs(new Date(Date.now() - 11 * H)));
    expect(await red()).toBeNull();
  });

  it("a feed never read is judged from its registration", async () => {
    feed("new", { lastOkAgoH: null, createdAgoH: 5, intervalH: 6 });
    expect(await red()).toBeNull();
    raw
      .prepare("UPDATE promoter_event_feeds SET created_at = ? WHERE id = 'new'")
      .run(secs(new Date(Date.now() - 13 * H)));
    expect(await red()).not.toBeNull();
  });

  it("evidence is the earliest deadline minus the window", () => {
    const now = new Date("2026-11-12T00:00:00Z");
    const a = { lastOkAt: new Date(now.getTime() - 10 * H), createdAt: now, pollIntervalHours: 6 };
    const b = { lastOkAt: new Date(now.getTime() - 1 * H), createdAt: now, pollIntervalHours: 1 };
    // a: deadline now+2h; b: now+1h → evidence = now+1h-1h = now
    expect(feedReaderEvidence([a, b], now).toISOString()).toBe(now.toISOString());
    expect(feedReaderEvidence([], now)).toBe(now);
  });
});

describe("FAM-FEED-READ-FAILED", () => {
  it("classifies the reader's auto-disable message, normalized as the scan sees it", () => {
    const message = `${FEED_READ_FAILED_FAULT} feed 0b555459-a15f-48b5-9c6f-7fa9bd2cd182 disabled after 5 consecutive failed reads; last error: HTTP 503`;
    const c = classifyFault({
      errorClass: normalizeErrorClass(message),
      route: "feeds:read-failed",
    });
    expect(c).toMatchObject({ disposition: "auto-classified", familyKey: "FAM-FEED-READ-FAILED" });
    // and does not swallow an ordinary feed error
    expect(
      classifyFault({ errorClass: normalizeErrorClass("feed read failed: HTTP 503") })
    ).toEqual({ disposition: "unclassified" });
  });
});
