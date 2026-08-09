import { describe, it, expect } from "vitest";
import {
  decideSilence,
  decideNewsletterMissing,
  SILENCE_THRESHOLD_MS,
  NEWSLETTER_LOOKBACK_MS,
} from "../src/agent-silence-watchdog.js";

const at = (iso: string) => new Date(iso);
const hoursAgo = (now: Date, h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

describe("decideSilence (OPE-348)", () => {
  const now = at("2026-08-09T08:00:00Z");

  it("is quiet when an agent checked in recently", () => {
    const v = decideSilence(
      { agentCode: "developer-claude-code", lastSeenAt: hoursAgo(now, 3) },
      now
    );
    expect(v.silent).toBe(false);
  });

  it("fires once the newest heartbeat passes the threshold", () => {
    const v = decideSilence(
      { agentCode: "developer-claude-code", lastSeenAt: hoursAgo(now, 30) },
      now
    );
    expect(v.silent).toBe(true);
    expect(v.staleHours).toBe(30);
  });

  it("would have caught the real outage on its SECOND daily check", () => {
    // The incident: quota exhausted 2026-08-05 ~13:00Z, reset 08-09. Being
    // precise about detection latency rather than claiming an instant catch.
    const lastRun = at("2026-08-05T13:00:00Z");

    // 08-06 08:00Z — only 19h stale. Correctly quiet: an agent that ran at
    // 13:00Z yesterday may simply not have run yet today.
    expect(
      decideSilence(
        { agentCode: "developer-claude-code", lastSeenAt: lastRun },
        at("2026-08-06T08:00:00Z")
      ).silent
    ).toBe(false);

    // 08-07 08:00Z — 43h stale. Fires. John learns on day 2 of what was a
    // 4-day silent outage, and before Friday's newsletter compose is missed.
    const v = decideSilence(
      { agentCode: "developer-claude-code", lastSeenAt: lastRun },
      at("2026-08-07T08:00:00Z")
    );
    expect(v.silent).toBe(true);
    expect(v.staleHours).toBe(43);
  });

  it("tolerates ordinary lateness just under the threshold", () => {
    // 26h, not 24h: a threshold equal to the cadence alarms on normal jitter,
    // and an alert that cries wolf is one that gets ignored.
    const justUnder = new Date(now.getTime() - SILENCE_THRESHOLD_MS + 60_000);
    expect(decideSilence({ agentCode: "a", lastSeenAt: justUnder }, now).silent).toBe(false);
    const justOver = new Date(now.getTime() - SILENCE_THRESHOLD_MS - 60_000);
    expect(decideSilence({ agentCode: "a", lastSeenAt: justOver }, now).silent).toBe(true);
  });

  it("stays quiet when NO agent has ever checked in", () => {
    // Before adoption there is nothing to be stale. Alarming daily until every
    // agent adopts the call would train the operator to ignore precisely the
    // alert that must never be ignored.
    expect(decideSilence(null, now).silent).toBe(false);
  });

  it("reports which agent was newest, so the mail says something useful", () => {
    const v = decideSilence(
      { agentCode: "analyst-claude-desktop", lastSeenAt: hoursAgo(now, 40) },
      now
    );
    expect(v.agentCode).toBe("analyst-claude-desktop");
  });
});

describe("decideNewsletterMissing (OPE-348)", () => {
  // 2026-08-07 was the Friday whose issue was never composed.
  const friday = at("2026-08-07T08:00:00Z");

  it("only runs on Friday — silent the rest of the week", () => {
    const thursday = at("2026-08-06T08:00:00Z");
    expect(decideNewsletterMissing(thursday, at("2026-07-31T00:42:00Z"))).toBe(false);
  });

  it("fires on the Friday the compose was actually missed", () => {
    // Latest issue was 07-31; on 08-07 that is a week stale.
    expect(decideNewsletterMissing(friday, at("2026-07-31T00:42:00Z"))).toBe(true);
  });

  it("does NOT fire when this week's issue was composed overnight", () => {
    // Real composes landed 00:42Z and 00:18Z Friday — the check must not race them.
    expect(decideNewsletterMissing(friday, at("2026-08-07T00:42:00Z"))).toBe(false);
  });

  it("still counts a Thursday compose", () => {
    // The lookback reaches back past midnight so an early compose isn't punished.
    const thursdayCompose = new Date(friday.getTime() - NEWSLETTER_LOOKBACK_MS + 60 * 60 * 1000);
    expect(decideNewsletterMissing(friday, thursdayCompose)).toBe(false);
  });

  it("fires when no issue has ever been composed", () => {
    expect(decideNewsletterMissing(friday, null)).toBe(true);
  });
});
