/**
 * Unit tests for K12 seed-discovery helper.
 *
 * Covers the decision branches documented at
 * src/goodwill/seed-discovery.ts:
 *   - skipped_no_url
 *   - skipped_invalid_url
 *   - skipped_opted_out (admin-rejected host)
 *   - skipped_cached (30-day TTL hit on either table)
 *   - promoted_to_discovery_candidates (T1/T2 happy path)
 *   - queued_to_email_source_suggestions (T3 happy path)
 *
 * The relevance classifier (./goodwill-relevance.test.ts) is the other
 * net-new K12 logic; together they cover the parts that are NOT
 * existing infrastructure being re-used.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { seedDiscoveryCandidate } from "../src/goodwill/seed-discovery.js";
import { discoveryCandidates, emailSourceSuggestions } from "../src/schema.js";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("seedDiscoveryCandidate — guard / skip paths", () => {
  it("returns skipped_no_url when sourceUrl is null", async () => {
    const result = await seedDiscoveryCandidate(db, {
      sourceUrl: null,
      fromAddress: "sender@example.com",
      inboundEmailId: "in-1",
    });
    expect(result.decision).toBe("skipped_no_url");
    expect(result.host).toBeNull();
    expect(result.tier).toBeNull();
  });

  it("returns skipped_invalid_url when sourceUrl is not parseable", async () => {
    const result = await seedDiscoveryCandidate(db, {
      sourceUrl: "not-a-url",
      fromAddress: "sender@example.com",
      inboundEmailId: "in-1",
    });
    expect(result.decision).toBe("skipped_invalid_url");
  });

  it("returns skipped_opted_out when host has a rejected email_source_suggestions row", async () => {
    await db.insert(emailSourceSuggestions).values({
      id: "ess-rejected",
      url: "https://organizer.example/old",
      host: "organizer.example",
      status: "rejected",
      createdAt: new Date(),
    });
    const result = await seedDiscoveryCandidate(db, {
      sourceUrl: "https://organizer.example/events/lupine",
      fromAddress: "sender@organizer.example", // T1 match
      inboundEmailId: "in-1",
    });
    expect(result.decision).toBe("skipped_opted_out");
    expect(result.host).toBe("organizer.example");
    expect(result.tier).toBe("T1");
  });
});

describe("seedDiscoveryCandidate — 30-day TTL cache", () => {
  it("returns skipped_cached when discovery_candidates row exists within 30 days", async () => {
    await db.insert(discoveryCandidates).values({
      id: "dc-recent",
      ruleSlug: "email_suggestion",
      sourceType: "aggregator",
      sourceLabel: "organizer.example",
      sourceUrl: "https://organizer.example/",
      status: "pending",
      createdAt: new Date(), // now
      updatedAt: new Date(),
    });
    const result = await seedDiscoveryCandidate(db, {
      sourceUrl: "https://organizer.example/events/lupine",
      fromAddress: "sender@organizer.example",
      inboundEmailId: "in-2",
    });
    expect(result.decision).toBe("skipped_cached");
    // Confirm no NEW row was inserted
    const rows = await db
      .select()
      .from(discoveryCandidates)
      .where(eq(discoveryCandidates.sourceLabel, "organizer.example"));
    expect(rows.length).toBe(1);
  });

  it("returns skipped_cached when email_source_suggestions row exists within 30 days", async () => {
    await db.insert(emailSourceSuggestions).values({
      id: "ess-recent",
      url: "https://otherhost.example/",
      host: "otherhost.example",
      status: "pending_review",
      createdAt: new Date(),
    });
    const result = await seedDiscoveryCandidate(db, {
      sourceUrl: "https://otherhost.example/calendar",
      fromAddress: "sender@example.com",
      inboundEmailId: "in-3",
    });
    expect(result.decision).toBe("skipped_cached");
  });

  it("does NOT cache-hit if the discovery_candidates row is older than 30 days", async () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago
    await db.insert(discoveryCandidates).values({
      id: "dc-old",
      ruleSlug: "email_suggestion",
      sourceType: "aggregator",
      sourceLabel: "stalehost.example",
      sourceUrl: "https://stalehost.example/",
      status: "pending",
      createdAt: oldDate,
      updatedAt: oldDate,
    });
    const result = await seedDiscoveryCandidate(db, {
      sourceUrl: "https://stalehost.example/events",
      fromAddress: "sender@stalehost.example",
      inboundEmailId: "in-4",
    });
    // T1 (organizer-domain) match → promoted, not cached
    expect(result.decision).toBe("promoted_to_discovery_candidates");
  });
});

describe("seedDiscoveryCandidate — T1/T2 auto-promotion to discovery_candidates", () => {
  it("T1 (organizer-domain) writes a new discovery_candidates row", async () => {
    const result = await seedDiscoveryCandidate(db, {
      sourceUrl: "https://historicrangeley.org/events/lupine-festival",
      fromAddress: "sender@historicrangeley.org", // T1 match
      inboundEmailId: "in-5",
    });
    expect(result.decision).toBe("promoted_to_discovery_candidates");
    expect(result.host).toBe("historicrangeley.org");
    expect(result.tier).toBe("T1");

    const rows = await db
      .select()
      .from(discoveryCandidates)
      .where(eq(discoveryCandidates.sourceLabel, "historicrangeley.org"));
    expect(rows.length).toBe(1);
    expect(rows[0].ruleSlug).toBe("email_suggestion");
    expect(rows[0].sourceType).toBe("aggregator");
    expect(rows[0].sourceUrl).toBe("https://historicrangeley.org/events/lupine-festival");
    expect(rows[0].status).toBe("pending");
  });

  it("strips leading www. when computing host", async () => {
    await seedDiscoveryCandidate(db, {
      sourceUrl: "https://www.historicrangeley.org/events",
      fromAddress: "sender@historicrangeley.org",
      inboundEmailId: "in-6",
    });
    const rows = await db
      .select()
      .from(discoveryCandidates)
      .where(eq(discoveryCandidates.sourceLabel, "historicrangeley.org"));
    expect(rows.length).toBe(1);
  });
});

describe("seedDiscoveryCandidate — T3 fallback to email_source_suggestions", () => {
  it("T3 writes a pending_review row in email_source_suggestions", async () => {
    const result = await seedDiscoveryCandidate(db, {
      // Use a domain that doesn't match the sender's email → T3.
      sourceUrl: "https://allevents.example/event/12345",
      fromAddress: "sender@example.com",
      inboundEmailId: "in-7",
    });
    expect(result.decision).toBe("queued_to_email_source_suggestions");
    expect(result.host).toBe("allevents.example");
    expect(result.tier).toBe("T3");

    const rows = await db
      .select()
      .from(emailSourceSuggestions)
      .where(eq(emailSourceSuggestions.host, "allevents.example"));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("pending_review");
    expect(rows[0].suggestedByEmail).toBe("sender@example.com");
    expect(rows[0].suggestedViaInboundId).toBe("in-7");
  });

  it("T3 second submit within 30 days hits the cache, doesn't double-insert", async () => {
    await seedDiscoveryCandidate(db, {
      sourceUrl: "https://allevents.example/event/12345",
      fromAddress: "first@example.com",
      inboundEmailId: "in-A",
    });
    const second = await seedDiscoveryCandidate(db, {
      sourceUrl: "https://allevents.example/event/67890",
      fromAddress: "second@example.com",
      inboundEmailId: "in-B",
    });
    expect(second.decision).toBe("skipped_cached");
    const rows = await db
      .select()
      .from(emailSourceSuggestions)
      .where(eq(emailSourceSuggestions.host, "allevents.example"));
    expect(rows.length).toBe(1);
  });
});

describe("seedDiscoveryCandidate — failsoft guarantee", () => {
  it("does not throw when fromAddress is null (no contactEmailDomain)", async () => {
    const result = await seedDiscoveryCandidate(db, {
      sourceUrl: "https://example-domain.test/events",
      fromAddress: null,
      inboundEmailId: null,
    });
    // Without fromAddress, T1 organizer-match can't fire; falls to T3.
    expect(result.decision).toBe("queued_to_email_source_suggestions");
    expect(result.host).toBe("example-domain.test");
  });
});
