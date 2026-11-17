/**
 * OPE-1660 — regression fixture for inbound `a3e8acb9` (Carolyn's forward of
 * Lois Taylor's Augusta Civic Center crafter-setup email, 2026-11-16 00:23Z).
 *
 * The ticket read this as "the OPE-1506 venue+date rule should have fired and
 * did not". Prod says otherwise: the stager's own verdict on the
 * `dedup.enrich_proposed` row was
 *
 *     autoApply: { basis: null,
 *                  reason: "not trusted, not a validated contact, not the promoter's domain" }
 *
 * because `shpandabear10@gmail.com` has NO `inbound_email_senders` row — the
 * pipeline's only definition of `trusted` (none of her 47 inbound rows ever took
 * the trusted fast-path either). The rule declined correctly. What was broken
 * was the READ: `get_inbound_email` dropped `autoApply` from every
 * `enrich_on_match` row and its note said "staged only — nothing was applied",
 * so a recorded decline was indistinguishable from "never ran".
 *
 * These pin both halves, against the email's real shape:
 *  1. as prod has it (sender not trusted): staged, and the decline reason plus
 *     `sender_trust_status: "unknown"` are readable from `get_inbound_email`;
 *  2. once the sender IS trusted: `indoor_outdoor=INDOOR` applies with a
 *     citation and a `dedup.enrich_applied` row, `get_inbound_email` lists that
 *     write, and the reply chooser picks the approved "matched a listing" copy.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  adminActions,
  eventDataCitations,
  eventDays,
  events,
  inboundEmails,
  inboundEmailSenders,
  promoters,
} from "../src/schema.js";
import {
  stageEnrichOnMatch,
  ENRICH_PROPOSED_ACTION,
} from "../src/email-handlers/enrich-proposal.js";
import { ENRICH_APPLIED_ACTION } from "../src/email-handlers/enrich-auto-apply.js";
import { chooseTrustedVenueDateReply } from "../src/email-handlers/trusted-no-url-reply.js";
import { registerInboundReadTools } from "../src/tools/admin-inbound-read.js";

let db: TestDb;

const INBOUND = "a3e8acb9-beac-4091-9885-c3d3b476a9a1";
const EVENT = "290769e0-1b97-4fd9-8cd8-808e850f845c";
const VENUE = "edf95965-augusta-civic-center";
const SENDER = "shpandabear10@gmail.com";
const RECEIVED = new Date("2026-11-16T00:23:31Z");

/** The extraction the stager received for a3e8acb9 (prod payload, verbatim). */
const EXTRACTED = {
  startDate: "2026-11-28",
  endDate: "2026-11-29",
  indoorOutdoor: "INDOOR",
  vendorFeeNotes: "Discounts available for early applications",
  visitorFacts: {
    parking: {
      excerpt: "please move your vehicle out of the way (to the other parking lot, to the",
    },
  },
};

function seed() {
  db.insert(promoters)
    .values({
      id: "p-cne",
      companyName: "CNE",
      slug: "cne",
      website: null,
      claimed: false,
    } as never)
    .run();
  db.insert(events)
    .values({
      id: EVENT,
      name: "Christmas in New England Arts and Craft Show 2026",
      slug: "christmas-in-new-england-arts-and-craft-show-2026",
      status: "APPROVED",
      lifecycleStatus: "SCHEDULED",
      promoterId: "p-cne",
      venueId: VENUE,
      startDate: new Date("2026-11-28T00:00:00Z"),
      endDate: new Date("2026-11-29T00:00:00Z"),
      createdAt: RECEIVED,
      updatedAt: RECEIVED,
    } as never)
    .run();
  db.insert(eventDays)
    .values({ id: `${EVENT}-d1`, eventId: EVENT, date: "2026-11-28" } as never)
    .run();
  // The rejected 2026-05 duplicate at the same venue — must not count.
  db.insert(events)
    .values({
      id: "dup-2026-05",
      name: "Christmas in New England (dup)",
      slug: "christmas-in-new-england-dup",
      status: "REJECTED",
      lifecycleStatus: "SCHEDULED",
      promoterId: "p-cne",
      venueId: VENUE,
      startDate: new Date("2026-11-28T00:00:00Z"),
      endDate: new Date("2026-11-29T00:00:00Z"),
      createdAt: RECEIVED,
      updatedAt: RECEIVED,
    } as never)
    .run();
  db.insert(inboundEmails)
    .values({
      id: INBOUND,
      receivedAt: RECEIVED,
      fromAddress: SENDER,
      toAddress: "submit@meetmeatthefair.com",
      subject: "Fwd: Christmas in New England — crafter setup Nov 28 & 29",
      intent: "new_event",
      status: "replied",
      senderAuth: "pass",
      originalSenderAuth: "unverifiable_inline_forward",
      attachmentCount: 0,
      createdAt: RECEIVED,
    } as never)
    .run();
}

const stage = () =>
  stageEnrichOnMatch(db as never, {
    existingEventId: EVENT,
    url: null,
    event: EXTRACTED,
    matchType: "venue_date",
    path: "single-high",
    inboundEmailId: INBOUND,
    fromAddress: SENDER,
  });

const actions = (action: string) =>
  db.select().from(adminActions).where(eq(adminActions.action, action)).all();

async function getInboundEmail() {
  const tools = new Map<string, (a: never) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, cb: (a: never) => Promise<never>) => {
      tools.set(name, cb as never);
    },
  } as never;
  registerInboundReadTools(server, db as never, { role: "ADMIN", userId: "u1" } as never);
  const res = await tools.get("get_inbound_email")!({ inbound_email_id: INBOUND } as never);
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  ({ db } = createTestDb());
  seed();
});

describe("OPE-1660 — a3e8acb9 as prod has it (sender has no trust row)", () => {
  it("stages, applies nothing, and records WHY on the row", async () => {
    const r = await stage();
    expect(r.outcome).toBe("proposed");
    expect((r as { applied: string[] }).applied).toEqual([]);
    expect(actions(ENRICH_APPLIED_ACTION)).toHaveLength(0);
    const payload = JSON.parse(actions(ENRICH_PROPOSED_ACTION)[0].payloadJson!);
    expect(payload.autoApply).toMatchObject({
      basis: null,
      reason: "not trusted, not a validated contact, not the promoter's domain",
      applied: [],
    });
    expect(payload.autoApply.eligible).toEqual(
      expect.arrayContaining(["indoor_outdoor", "vendor_fee_notes", "parking_notes"])
    );
  });

  it("get_inbound_email shows the decline reason and the sender's trust — 'declined because X', not 'never ran'", async () => {
    await stage();
    const out = await getInboundEmail();
    expect(out.sender_trust_status).toBe("unknown");
    expect(out.enrich_on_match).toHaveLength(1);
    expect(out.enrich_on_match[0].auto_apply).toMatchObject({
      basis: null,
      reason: "not trusted, not a validated contact, not the promoter's domain",
    });
    // The note no longer claims nothing can ever be applied.
    expect(out.enrich_on_match_note).not.toMatch(/nothing was applied/);
    expect(out.enrich_on_match_note).toMatch(/dedup\.enrich_applied/);
  });

  it("the reply chooser keeps the generic copy for an untrusted sender (same gate as the rule)", () => {
    expect(
      chooseTrustedVenueDateReply({
        senderTrust: "unknown",
        matchType: "venue_date",
        listingUrl:
          "https://meetmeatthefair.com/events/christmas-in-new-england-arts-and-craft-show-2026",
        name: "Christmas in New England Arts and Craft Show 2026",
        applied: [],
        staged: true,
      })
    ).toBeNull();
  });
});

describe("OPE-1660 — a3e8acb9 once the sender IS trusted", () => {
  beforeEach(() => {
    db.insert(inboundEmailSenders)
      .values({
        email: SENDER,
        trustStatus: "trusted",
        createdAt: RECEIVED,
        updatedAt: RECEIVED,
      } as never)
      .run();
  });

  it("applies indoor_outdoor=INDOOR with a citation and a dedup.enrich_applied row (the rejected duplicate does not count)", async () => {
    const r = await stage();
    expect((r as { applied: string[] }).applied).toContain("indoor_outdoor");
    const ev = db.select().from(events).where(eq(events.id, EVENT)).get()!;
    expect(ev.indoorOutdoor).toBe("INDOOR");
    const cites = db
      .select()
      .from(eventDataCitations)
      .where(
        and(
          eq(eventDataCitations.eventId, EVENT),
          eq(eventDataCitations.fieldName, "indoor_outdoor")
        )
      )
      .all();
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ value: "INDOOR", state: "active" });
    const applied = actions(ENRICH_APPLIED_ACTION);
    expect(applied).toHaveLength(1);
    const p = JSON.parse(applied[0].payloadJson!);
    expect(p).toMatchObject({ basis: "trusted", path: "single-high", matchType: "venue_date" });
    expect(p.fields.map((f: { field: string }) => f.field)).toContain("indoor_outdoor");
  });

  it("get_inbound_email lists the WRITE, not only the staged row", async () => {
    await stage();
    const out = await getInboundEmail();
    expect(out.sender_trust_status).toBe("trusted");
    const appliedRow = out.enrich_on_match.find(
      (r: { action: string }) => r.action === ENRICH_APPLIED_ACTION
    );
    expect(appliedRow).toBeDefined();
    expect(appliedRow.basis).toBe("trusted");
    expect(appliedRow.applied_fields.map((f: { field: string }) => f.field)).toContain(
      "indoor_outdoor"
    );
  });

  it("the trusted sender gets the approved 'matched a listing' reply", () => {
    const choice = chooseTrustedVenueDateReply({
      senderTrust: "trusted",
      matchType: "venue_date",
      listingUrl:
        "https://meetmeatthefair.com/events/christmas-in-new-england-arts-and-craft-show-2026",
      name: "Christmas in New England Arts and Craft Show 2026",
      applied: ["indoor_outdoor"],
      staged: true,
    });
    expect(choice?.replyKind).toBe("trusted-listing-match");
  });
});
