/**
 * OPE-259 — dead-man's switch for the 06:00 CPI scan.
 *
 * The scan skipped 2026-07-19 with zero alarms. It is the evaluator for every
 * heartbeat/freeze/silence red, so when it dies the dashboard looks calm
 * because nothing is being measured — the worst possible failure shape.
 *
 * These pin the three things that decide whether this watchdog is trustworthy:
 * it fires on a real miss, it does NOT fire on ordinary jitter, and it never
 * throws into the cron that runs it.
 */
import { describe, it, expect, vi } from "vitest";
import { CPI_SCAN_STALE_HOURS, runScheduledCpiScanWatchdog } from "../src/cpi-scan-watchdog.js";

vi.mock("../src/logger.js", () => ({ logError: vi.fn(async () => {}) }));

const NOW = new Date("2026-07-21T08:00:00Z");

/** env whose snapshot table reports `lastAtSeconds` (or null / a thrown error). */
function envWith(
  lastAtSeconds: number | null,
  opts: { withEmail?: boolean; throws?: boolean } = {}
) {
  const sent: Array<Record<string, unknown>> = [];
  const env = {
    DB: {
      prepare: () => ({
        first: async () => {
          if (opts.throws) throw new Error("D1 unavailable");
          return { last_at: lastAtSeconds };
        },
      }),
    },
    ALERT_EMAIL_TECHNICAL: opts.withEmail === false ? undefined : "alert@x.com,john@x.com",
    EMAIL_JOBS:
      opts.withEmail === false
        ? undefined
        : {
            send: async (m: Record<string, unknown>) => {
              sent.push(m);
            },
          },
  };
  return { env: env as never, sent };
}

/** seconds-epoch for `hours` before NOW */
const hoursAgo = (hours: number) => Math.floor((NOW.getTime() - hours * 3_600_000) / 1000);

describe("runScheduledCpiScanWatchdog", () => {
  it("stays quiet on a normal daily gap (~24h)", async () => {
    // The scan runs at 06:00 and the watchdog at 08:00, so a healthy observed
    // age is ~26h. A 24h threshold would false-fire here every single day.
    const { env, sent } = envWith(hoursAgo(26));
    const out = await runScheduledCpiScanWatchdog(env, NOW);

    expect(out.stale).toBe(false);
    expect(out.alerted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("does not fire exactly at the threshold — only past it", async () => {
    const { env, sent } = envWith(hoursAgo(CPI_SCAN_STALE_HOURS));
    expect((await runScheduledCpiScanWatchdog(env, NOW)).stale).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("fires on a genuinely skipped day", async () => {
    // The 2026-07-19 shape: one whole run missed, so the newest evidence is
    // ~2 days old by the time the watchdog looks.
    const { env, sent } = envWith(hoursAgo(50));
    const out = await runScheduledCpiScanWatchdog(env, NOW);

    expect(out.stale).toBe(true);
    expect(out.alerted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(String(sent[0].subject)).toContain("CPI scan appears DEAD");
    // Goes to the operator channel, which now dual-delivers to John's Gmail.
    expect(sent[0].to).toBe("alert@x.com,john@x.com");
    // The body must explain WHY a dead scan is worse than a missed job.
    expect(String(sent[0].text)).toContain("EVALUATES every heartbeat probe");
  });

  it("treats a never-written table as idle, not as a dead scan", async () => {
    // queue_drain_snapshots shipped recently (OPE-247). Alarming on an empty
    // table would train the operator to ignore this alert before it matters.
    const { env, sent } = envWith(null);
    const out = await runScheduledCpiScanWatchdog(env, NOW);

    expect(out.stale).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("records staleness even when email is unconfigured", async () => {
    const { env, sent } = envWith(hoursAgo(50), { withEmail: false });
    const out = await runScheduledCpiScanWatchdog(env, NOW);

    expect(out.stale).toBe(true);
    expect(out.alerted).toBe(false); // logged, not emailed
    expect(sent).toHaveLength(0);
  });

  it("never throws into the cron branch", async () => {
    const { env } = envWith(null, { throws: true });
    await expect(runScheduledCpiScanWatchdog(env, NOW)).resolves.toMatchObject({ stale: false });
  });
});
