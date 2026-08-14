import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  decideSilence,
  decideNewsletterMissing,
  decideNewsletterUnsent,
  SILENCE_THRESHOLD_MS,
  NEWSLETTER_LOOKBACK_MS,
  runAgentSilenceWatchdog,
} from "../src/agent-silence-watchdog.js";
import { createTestDb } from "./setup-db.js";
import { agentHeartbeats, newsletterIssues } from "../src/schema.js";

// getDb() is module-level in the watchdog, so the seam has to be the module.
// Hoisted holder because vi.mock's factory runs before beforeEach.
const harness = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));

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

describe("decideNewsletterUnsent — composed is not sent (OPE-348 follow-up)", () => {
  const friday = at("2026-08-14T06:00:00Z");

  it("fires when the issue exists but was never delivered", () => {
    // Not hypothetical: on 2026-08-11 production held e9dfc329 (created 08-10)
    // and e6c2496c (07-20), both with sent_at NULL. The compose tripwire is
    // silent on both, because compose is not the customer-facing event —
    // a subscriber cannot read a draft.
    expect(
      decideNewsletterUnsent(friday, { createdAt: at("2026-08-10T02:00:18Z"), sentAt: null })
    ).toBe(true);
  });

  it("stays quiet once the issue has actually gone out", () => {
    expect(
      decideNewsletterUnsent(friday, {
        createdAt: at("2026-08-10T02:00:18Z"),
        sentAt: at("2026-08-10T02:07:00Z"),
      })
    ).toBe(false);
  });

  it("gives a fresh compose time to send before complaining", () => {
    // Composed 00:42Z this morning, not yet sent at 06:00Z — that is the normal
    // gap between compose and send, not a failure.
    expect(
      decideNewsletterUnsent(friday, { createdAt: at("2026-08-14T00:42:00Z"), sentAt: null })
    ).toBe(false);
  });

  it("leaves 'nothing exists at all' to the compose check", () => {
    // Two distinct faults with two distinct causes: nothing composed means the
    // agent layer did not run; composed-but-unsent means it ran and delivery
    // broke. One alert reporting both could not tell you which.
    expect(decideNewsletterUnsent(friday, null)).toBe(false);
  });

  it("only runs on Friday", () => {
    expect(
      decideNewsletterUnsent(at("2026-08-13T06:00:00Z"), {
        createdAt: at("2026-08-01T00:00:00Z"),
        sentAt: null,
      })
    ).toBe(false);
  });
});

/**
 * OPE-348 rework (2026-08-11) — the drill.
 *
 * The analyst returned this ticket for one reason: the alarm had only ever
 * reported "ok". These tests cover the positive case end-to-end through the
 * real function — read, decide, compose, enqueue — because the pure-function
 * tests above prove the maths and say nothing about whether an email is
 * actually produced.
 */
describe("runAgentSilenceWatchdog drill mode (OPE-348)", () => {
  let db: any;
  let sent: any[];
  let env: any;

  const seedHeartbeat = async (agentCode: string, kind: string, lastSeenAt: Date) =>
    db.insert(agentHeartbeats).values({ id: crypto.randomUUID(), agentCode, kind, lastSeenAt });

  beforeEach(() => {
    ({ db: harness.db } = createTestDb());
    db = harness.db;
    sent = [];
    env = {
      DB: {} as any,
      EMAIL_JOBS: {
        send: async (m: any) => {
          sent.push(m);
        },
      },
      ALERT_EMAIL_TECHNICAL: "alert@meetmeatthefair.com, jtarboxme@gmail.com",
    };
  });

  it("produces a real alert when the clock is pushed past the threshold", async () => {
    // The heartbeat is genuinely fresh; only the clock moves. This is the
    // induced-silence case the ticket's acceptance criterion names.
    const realNow = at("2026-08-11T14:07:00Z");
    await seedHeartbeat("developer-claude-code", "agent", realNow);

    const result = await runAgentSilenceWatchdog(env, {
      now: new Date(realNow.getTime() + 48 * 60 * 60 * 1000),
      drill: true,
      dryRun: false,
    });

    expect(result.silent).toBe(true);
    expect(result.staleHours).toBe(48);
    expect(result.alerted).toBe(true);
    expect(sent).toHaveLength(1);
    // Recipients must reach the queue as the FULL operator list (OPE-261).
    expect(sent[0].to).toBe("alert@meetmeatthefair.com, jtarboxme@gmail.com");
    expect(sent[0].source).toBe("agent-silence-watchdog");
    expect(sent[0].text).toContain("developer-claude-code");
  });

  it("marks the subject so a rehearsal is never mistaken for a real outage", async () => {
    await seedHeartbeat("developer-claude-code", "agent", at("2026-08-11T14:07:00Z"));
    const result = await runAgentSilenceWatchdog(env, {
      now: at("2026-08-13T14:07:00Z"),
      drill: true,
      dryRun: false,
    });
    expect(result.subject).toBe("[DRILL] 🚨 Agent layer silent for 48h");
    expect(sent[0].subject.startsWith("[DRILL] ")).toBe(true);
  });

  it("defaults to dry-run: an unqualified drill mails nobody", async () => {
    await seedHeartbeat("developer-claude-code", "agent", at("2026-08-11T14:07:00Z"));
    const result = await runAgentSilenceWatchdog(env, {
      now: at("2026-08-13T14:07:00Z"),
      drill: true,
      dryRun: true,
    });
    // It still reports what it WOULD have done — a dry run that hides the
    // verdict would be useless for checking the alarm before firing it.
    expect(result.silent).toBe(true);
    expect(result.subject).toBe("[DRILL] 🚨 Agent layer silent for 48h");
    expect(result.alerted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("leaves the watchdog's own evidence row untouched", async () => {
    // The run-stamp is the OPE-246 proof that the watchdog executes. A drill
    // writing into it would push last_seen_at into the future and record
    // note='alerted' for an outage that never happened.
    const stamp = at("2026-08-11T08:00:59Z");
    await seedHeartbeat("watchdog:agent-silence", "watchdog", stamp);
    await seedHeartbeat("developer-claude-code", "agent", at("2026-08-11T14:07:00Z"));

    await runAgentSilenceWatchdog(env, {
      now: at("2026-08-13T14:07:00Z"),
      drill: true,
      dryRun: false,
    });

    const [row] = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, "watchdog:agent-silence"));
    expect(row.lastSeenAt.toISOString()).toBe(stamp.toISOString());
    expect(row.note).toBeNull();
  });

  it("a production run (no options) DOES stamp its own execution", async () => {
    // The complement of the test above — proving the skip is drill-only and
    // the real cron still leaves its evidence.
    await seedHeartbeat("developer-claude-code", "agent", new Date());
    // OPE-370 drive-by: this test ran on the REAL clock and asserted no mail was
    // sent, so it failed every FRIDAY — `decideNewsletterMissing` is Friday-only,
    // and with no issue seeded the tripwire fired and produced the very alert the
    // assertion forbids. Caught 2026-08-14 (a Friday); it would have gone red in
    // CI on any Friday run and had nothing to do with the watchdog's stamping.
    //
    // Seeding this week's issue satisfies the newsletter branch on every weekday,
    // so the test now isolates what it claims to test: that a production run
    // stamps its own execution and alarms nothing.
    await db.insert(newsletterIssues).values({
      id: crypto.randomUUID(),
      slug: "issue-current-week",
      subject: "Weekend picks",
      html: "<p>hi</p>",
      audience: "weekend",
      createdAt: new Date(),
    });
    await runAgentSilenceWatchdog(env);

    const [row] = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, "watchdog:agent-silence"));
    expect(row).toBeDefined();
    expect(row.note).toBe("ok");
    expect(sent).toHaveLength(0);
  });

  it("an enormous threshold isolates the newsletter tripwire from the silence alarm", async () => {
    // Rehearsing the newsletter half on its own: the agents are fine, the
    // compose is not. Without the threshold override both fire at once and the
    // drill proves nothing about which branch produced the mail.
    await seedHeartbeat("developer-claude-code", "agent", at("2026-08-11T14:07:00Z"));
    await db.insert(newsletterIssues).values({
      id: crypto.randomUUID(),
      slug: "issue-2026-08-10",
      subject: "Weekend picks",
      html: "<p>hi</p>",
      audience: "weekend",
      createdAt: at("2026-08-10T02:00:18Z"),
    });

    const result = await runAgentSilenceWatchdog(env, {
      now: at("2026-08-14T06:00:00Z"), // a Friday
      thresholdMs: Number.MAX_SAFE_INTEGER,
      drill: true,
      dryRun: false,
    });

    expect(result.silent).toBe(false);
    expect(result.newsletterMissing).toBe(true);
    expect(result.subject).toBe("[DRILL] 🚨 Newsletter not composed this week");
    expect(sent).toHaveLength(1);
  });

  it("stays silent on a normal day — the negative case still holds", async () => {
    await seedHeartbeat("developer-claude-code", "agent", at("2026-08-11T14:07:00Z"));
    const result = await runAgentSilenceWatchdog(env, {
      now: at("2026-08-11T16:00:00Z"),
      drill: true,
      dryRun: false,
    });
    expect(result.silent).toBe(false);
    expect(result.alerted).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
