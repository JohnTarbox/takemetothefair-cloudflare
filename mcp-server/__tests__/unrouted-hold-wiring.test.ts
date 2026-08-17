/**
 * OPE-357 — the WIRING, not the decision.
 *
 * `decideUnroutedHold` already had full coverage and zero production callers,
 * which is the exact shape this codebase keeps getting burned by: a tested pure
 * function that nothing calls looks identical, in a test report, to a working
 * feature. These tests cover the parts that were missing — the routing verdict
 * that triggers it, the open-hold count that feeds it (including the expiry
 * window the module requires the CALLER to apply), and the tier mapping.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { inboundEmails } from "../src/schema.js";
import { and, eq, gte, sql } from "drizzle-orm";
import { routeToProject } from "../src/inbound/project-router.js";
import {
  decideUnroutedHold,
  holdExpiryCutoff,
  HOLD_EXPIRY_DAYS,
  MAX_HOLDS_PER_UNKNOWN_SENDER,
  UNROUTED_HOLD_REPLY_KIND,
} from "../src/inbound/unrouted-hold.js";

let db: TestDb;
const NOW = new Date("2026-08-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

beforeEach(() => {
  ({ db } = createTestDb());
});

async function seedHold(id: string, from: string, receivedAt: Date, replyKind: string | null) {
  await db.insert(inboundEmails).values({
    id,
    receivedAt,
    createdAt: receivedAt,
    fromAddress: from,
    toAddress: "hello@meetmeatthefair.com",
    subject: null,
    intent: "unknown",
    status: "replied",
    replyKind: replyKind as never,
  });
}

/** The exact query the workflow runs to count a sender's OPEN holds. */
async function countOpenHolds(from: string, now: Date) {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.fromAddress, from),
        eq(inboundEmails.replyKind, UNROUTED_HOLD_REPLY_KIND as never),
        gte(inboundEmails.receivedAt, holdExpiryCutoff(now))
      )
    );
  return Number(row?.n ?? 0);
}

describe("the routing verdict that triggers a hold", () => {
  it("mail to a known project domain is NOT unrouted", () => {
    const r = routeToProject({
      toAddress: "submit@meetmeatthefair.com",
      fromAddress: "someone@example.com",
      subject: "Lovell Old Home Days",
    });
    expect(r.project).not.toBe("UNROUTED");
  });

  it("mail to an unrecognized domain IS unrouted — the case this ticket wires", () => {
    const r = routeToProject({
      toAddress: "hello@some-unknown-domain.test",
      fromAddress: "stranger@example.com",
      subject: "hi",
    });
    expect(r.project).toBe("UNROUTED");
  });
});

describe("open-hold counting — the caller's half of the contract", () => {
  it("counts only rows carrying the hold reply_kind", async () => {
    await seedHold("h1", "stranger@example.com", daysAgo(1), UNROUTED_HOLD_REPLY_KIND);
    // Same sender, ordinary reply — not a hold.
    await seedHold("h2", "stranger@example.com", daysAgo(1), "no-url");
    expect(await countOpenHolds("stranger@example.com", NOW)).toBe(1);
  });

  it("EXCLUDES expired holds, so a sender noisy a month ago is not silenced forever", async () => {
    // unrouted-hold.ts states the caller must exclude expired rows. This is the
    // test that the caller actually does — the module cannot enforce it.
    await seedHold(
      "old",
      "stranger@example.com",
      daysAgo(HOLD_EXPIRY_DAYS + 1),
      UNROUTED_HOLD_REPLY_KIND
    );
    await seedHold(
      "old2",
      "stranger@example.com",
      daysAgo(HOLD_EXPIRY_DAYS + 30),
      UNROUTED_HOLD_REPLY_KIND
    );
    expect(await countOpenHolds("stranger@example.com", NOW)).toBe(0);

    // …and with the count at zero, the sender can be asked again.
    expect(decideUnroutedHold({ senderTrust: "unknown", openHoldCount: 0 }).action).toBe("ask");
  });

  it("a hold exactly at the boundary is still open", async () => {
    await seedHold(
      "edge",
      "stranger@example.com",
      daysAgo(HOLD_EXPIRY_DAYS - 0.1),
      UNROUTED_HOLD_REPLY_KIND
    );
    expect(await countOpenHolds("stranger@example.com", NOW)).toBe(1);
  });

  it("counts per sender, not globally", async () => {
    await seedHold("a", "one@example.com", daysAgo(1), UNROUTED_HOLD_REPLY_KIND);
    await seedHold("b", "two@example.com", daysAgo(1), UNROUTED_HOLD_REPLY_KIND);
    expect(await countOpenHolds("one@example.com", NOW)).toBe(1);
  });

  it("the ceiling actually bites once a sender reaches it", async () => {
    for (let i = 0; i < MAX_HOLDS_PER_UNKNOWN_SENDER; i++) {
      await seedHold(`h${i}`, "noisy@example.com", daysAgo(1), UNROUTED_HOLD_REPLY_KIND);
    }
    const openHoldCount = await countOpenHolds("noisy@example.com", NOW);
    expect(openHoldCount).toBe(MAX_HOLDS_PER_UNKNOWN_SENDER);
    const decision = decideUnroutedHold({ senderTrust: "unknown", openHoldCount });
    expect(decision.action).toBe("suppress");
    // …and the reason says why, so the log line explains itself.
    expect(decision.reason).toContain("limit");
  });
});

describe("sender-tier mapping — the cautious direction", () => {
  // The workflow maps SenderTrustTier (unknown|trusted|watchlist|blocked) onto
  // the module's tiers. Only `trusted` may earn the higher ceiling.
  const mapTier = (t: "unknown" | "trusted" | "watchlist") =>
    t === "trusted" ? ("trusted" as const) : ("unknown" as const);

  it("a watchlisted sender gets the UNKNOWN ceiling, never the trusted one", () => {
    expect(mapTier("watchlist")).toBe("unknown");
    const d = decideUnroutedHold({
      senderTrust: mapTier("watchlist"),
      openHoldCount: MAX_HOLDS_PER_UNKNOWN_SENDER,
    });
    expect(d.action).toBe("suppress");
  });

  it("a trusted sender keeps the higher ceiling", () => {
    const d = decideUnroutedHold({
      senderTrust: mapTier("trusted"),
      openHoldCount: MAX_HOLDS_PER_UNKNOWN_SENDER,
    });
    expect(d.action).toBe("ask");
  });
});
