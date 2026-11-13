// @vitest-environment node
/**
 * OPE-1633 — the `feed-health-eval` heartbeat probe reads the hourly poll's
 * `feeds:health-eval` info row (the flags table is rightly empty when every
 * feed is healthy, so it cannot be the evidence). Driven both ways: silent
 * when no run row exists, healthy when one does, and a warn row on the same
 * source is not evidence.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../mcp-server/__tests__/setup-db";
import { HEARTBEAT_PROBES, assessHeartbeatSilence } from "@/lib/heartbeat";
import { FEED_HEALTH_SOURCE } from "../../../mcp-server/src/feeds/health";

const H = 3_600_000;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "feed-health-eval")!;

let db: ReturnType<typeof createTestDb>["db"];
let raw: Database.Database;
beforeEach(() => {
  ({ db, raw } = createTestDb());
});

const log = (level: string, source: string, agoH: number) =>
  raw
    .prepare(
      "INSERT INTO error_logs (id, timestamp, level, source, message) VALUES (?, ?, ?, ?, 'feed health: evaluated 3 enabled feeds, 0 stale, 0 flags open')"
    )
    .run(crypto.randomUUID(), secs(new Date(Date.now() - agoH * H)), level, source);

const red = async (enabledAgoH: number) =>
  assessHeartbeatSilence(
    {
      probe,
      enabledAt: new Date(Date.now() - enabledAgoH * H),
      lastEvidenceAt: await probe.lastEvidenceAt(db as never),
    },
    new Date()
  );

describe("OPE-1633 — feed-health-eval probe", () => {
  it("is registered, P1, with a 3h window, and its source matches the writer's", () => {
    expect(probe).toMatchObject({ ownerOpe: "OPE-1633", priority: "P1", expectedWindowHours: 3 });
    expect(FEED_HEALTH_SOURCE).toBe("feeds:health-eval");
  });

  it("no run row → no evidence, and RED once the window has passed since enabling", async () => {
    expect(await probe.lastEvidenceAt(db as never)).toBeNull();
    expect(await red(4)).not.toBeNull();
    expect(await red(1)).toBeNull(); // still inside the first window
  });

  it("an hourly run row is evidence; a warn row on the same source is not", async () => {
    log("warn", FEED_HEALTH_SOURCE, 0.5);
    log("info", "feeds:scheduled-poll", 0.5);
    expect(await probe.lastEvidenceAt(db as never)).toBeNull();
    log("info", FEED_HEALTH_SOURCE, 1);
    const at = await probe.lastEvidenceAt(db as never);
    expect(at!.getTime()).toBeGreaterThan(Date.now() - 1.1 * H);
    expect(await red(48)).toBeNull();
  });

  it("RED when the last run row is older than 3h", async () => {
    log("info", FEED_HEALTH_SOURCE, 4);
    expect(await red(48)).not.toBeNull();
  });
});
