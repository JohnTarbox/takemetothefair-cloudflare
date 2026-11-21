/**
 * OPE-1340 ask 2 (per-entity copy, John's Option A ruling 2026-10-20) and
 * OPE-1507 (personal note, subject override, dry_run) — create_claim_invite.
 *
 * No live sends: EMAIL_JOBS is a capturing mock throughout.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  registerCreateClaimInviteTool,
  renderInviteEmail,
  OTHER_SHOWS_PARAGRAPH,
  OTHER_SHOWS_LIVE,
  FOURTEEN_DAY_LINE,
  DRY_RUN_TOKEN_PLACEHOLDER,
} from "../src/tools/admin-claim-invite.js";
import {
  vendors,
  promoters,
  events,
  claimTokens,
  vendorOutreachAttempts,
  adminActions,
} from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const URL = "https://meetmeatthefair.com/register?role=VENDOR&claim=acme&invite=abc123";

let db: TestDb;
let server: CapturingMcpServer;
let sent: Array<Record<string, string>>;

const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;
const before = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  const j = s.indexOf(b);
  expect(i, `missing: ${a}`).toBeGreaterThanOrEqual(0);
  expect(j, `missing: ${b}`).toBeGreaterThanOrEqual(0);
  return i < j;
};

async function invoke(params: Record<string, unknown>) {
  const res = (await server.invoke("create_claim_invite", params)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  sent = [];
  registerCreateClaimInviteTool(server as never, db, ADMIN_AUTH, {
    EMAIL_JOBS: { send: async (m: Record<string, string>) => void sent.push(m) },
    INTERNAL_API_KEY: "test-secret",
  } as never);
  db.insert(vendors)
    .values({
      id: "v-1",
      userId: "user-v-1",
      businessName: "Acme Crafts",
      slug: "acme-crafts",
      contactEmail: "owner@acme.test",
      claimed: false,
    })
    .run();
  db.insert(promoters)
    .values({
      id: "p-1",
      companyName: "Fair Org",
      slug: "fair-org",
      contactEmail: "org@fair.test",
      claimed: false,
    })
    .run();
});

function seedShow(id: string, startIso: string, status = "APPROVED") {
  db.insert(events)
    .values({
      id,
      name: id,
      slug: id,
      status,
      lifecycleStatus: "SCHEDULED",
      promoterId: "p-1",
      startDate: new Date(startIso),
      endDate: new Date(startIso),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)
    .run();
}

describe("OPE-1340 — per-entity copy (Option A)", () => {
  it("PROMOTER: the approved draft, {N} public upcoming shows, button, 14-day line, one sign-off", async () => {
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const past = new Date(Date.now() - 30 * 864e5).toISOString();
    seedShow("up-1", future);
    seedShow("up-2", future);
    seedShow("old", past); // over — not counted
    seedShow("rej", future, "REJECTED"); // not public — not counted
    await invoke({ entity_type: "PROMOTER", entity_id: "p-1" });
    const m = sent[0];
    expect(m.subject).toBe("Your shows are on Meet Me at the Fair — claim your page");
    expect(m.html).toContain("<p>Hello,</p>");
    expect(m.html).toContain(
      "Fair Org is listed on Meet Me at the Fair, a free directory that helps people across New England find fairs, festivals and craft shows."
    );
    expect(m.text).toContain("Your page shows 2 upcoming shows. Once it's yours, you can:");
    expect(m.html).toContain(
      "<li>add a new show, or copy this year&#39;s to next year in a couple of clicks</li>"
    );
    expect(before(m.html, "Claim your page", FOURTEEN_DAY_LINE)).toBe(true);
    expect(before(m.html, FOURTEEN_DAY_LINE, "John<br>")).toBe(true);
    expect(
      count(/John<br><a href="https:\/\/meetmeatthefair\.com">meetmeatthefair\.com<\/a>/g, m.html)
    ).toBe(1);
    expect(m.text).toContain("John\nhttps://meetmeatthefair.com");
    // Promoter copy is not vendor copy.
    expect(m.html).not.toMatch(/photos and products|shoppers/);
  });

  it("PROMOTER with no upcoming public shows: the {N} sentence is dropped, not '0 shows'", async () => {
    await invoke({ entity_type: "PROMOTER", entity_id: "p-1" });
    expect(sent[0].text).toContain("It's free.\n\nOnce it's yours, you can:");
    expect(sent[0].text).not.toMatch(/Your page shows/);
  });

  it("one show reads singular", () => {
    const r = renderInviteEmail({ entityType: "PROMOTER", name: "X", url: URL, upcomingShows: 1 });
    expect(r.text).toContain("Your page shows 1 upcoming show. Once");
  });

  it("PERFORMER: the approved draft", () => {
    const r = renderInviteEmail({ entityType: "PERFORMER", name: "The Fiddlers", url: URL });
    expect(r.subject).toBe("Claim your performer page on Meet Me at the Fair");
    expect(r.html).toContain(
      "The Fiddlers has a page on Meet Me at the Fair, a free directory of New England fairs, festivals and craft shows."
    );
    expect(r.html).toContain(FOURTEEN_DAY_LINE);
    expect(count(/John<br>/g, r.html)).toBe(1);
  });

  it("VENDOR: body copy unchanged; the old brand sign-off is replaced, never doubled", () => {
    const r = renderInviteEmail({ entityType: "VENDOR", name: "Acme Crafts", url: URL });
    expect(r.subject).toBe("Claim your free listing on Meet Me at the Fair");
    expect(r.text.startsWith("Hi Acme Crafts,\n\nYou're listed on Meet Me at the Fair")).toBe(true);
    expect(r.text).toContain("This link is just for you and gets you straight there:\n  " + URL);
    expect(r.text).toContain("There's no cost and no catch");
    expect(r.text).not.toContain("— Meet Me at the Fair");
    expect(count(/John<br>/g, r.html)).toBe(1);
  });

  it("the claim URL is inside an href on every entity type (the OPE-1340 test, kept)", () => {
    for (const entityType of ["VENDOR", "PROMOTER", "PERFORMER"] as const) {
      const r = renderInviteEmail({ entityType, name: "X", url: URL });
      const escaped = URL.replace(/&/g, "&amp;");
      expect(r.html).toContain(`href="${escaped}"`);
    }
  });
});

describe("OPE-1340 — the 'other shows' paragraph (approved, NOT live)", () => {
  it("is off today: absent from every live render", () => {
    expect(OTHER_SHOWS_LIVE).toBe(false);
    for (const entityType of ["VENDOR", "PROMOTER", "PERFORMER"] as const) {
      const r = renderInviteEmail({ entityType, name: "X", url: URL });
      expect(r.html).not.toContain(OTHER_SHOWS_PARAGRAPH[entityType].slice(0, 30));
    }
  });

  it("when enabled, renders per entity type after the button and before the closing line — with and without a note", () => {
    for (const entityType of ["VENDOR", "PROMOTER", "PERFORMER"] as const) {
      for (const personalNote of [null, "Hello from John."]) {
        const r = renderInviteEmail({
          entityType,
          name: "X",
          url: URL,
          personalNote,
          otherShows: true,
        });
        const para = OTHER_SHOWS_PARAGRAPH[entityType].replace(/'/g, "&#39;");
        expect(count(new RegExp(para.slice(0, 25), "g"), r.html)).toBe(1);
        expect(before(r.html, "Claim your page</a>", para)).toBe(true);
        expect(before(r.html, para, "John<br>")).toBe(true);
      }
    }
  });
});

describe("OPE-1507 — personal note", () => {
  const NOTE =
    "Hi Jane,\n\nWe met at the Kittery expo <b>Oct 28</b> & I promised a link.\nYour page is at https://meetmeatthefair.com/vendors/acme-crafts.\n\nSee you there!";

  it("the note replaces greeting + body and sits ABOVE the button; one sign-off; no template greeting", () => {
    const r = renderInviteEmail({
      entityType: "VENDOR",
      name: "Acme Crafts",
      url: URL,
      personalNote: NOTE,
    });
    expect(before(r.html, "We met at the Kittery expo", "Claim your page")).toBe(true);
    expect(r.html).not.toContain("Hi Acme Crafts");
    expect(r.html).not.toContain("<p>Hello,</p>");
    expect(r.html).not.toContain("You&#39;re listed on Meet Me at the Fair");
    expect(count(/John<br>/g, r.html)).toBe(1);
    expect(r.html).toContain(FOURTEEN_DAY_LINE);
    expect(before(r.html, "Claim your page", FOURTEEN_DAY_LINE)).toBe(true);
  });

  it("HTML in the note is escaped; paragraph and line breaks are kept", () => {
    const r = renderInviteEmail({ entityType: "VENDOR", name: "A", url: URL, personalNote: NOTE });
    expect(r.html).toContain("&lt;b&gt;Oct 28&lt;/b&gt; &amp; I promised a link.<br>");
    expect(r.html).not.toContain("<b>Oct 28</b>");
    expect(r.html).toContain("<p>Hi Jane,</p><p>We met");
  });

  it("a bare https:// URL in the note becomes a link, trailing period outside the href", () => {
    const r = renderInviteEmail({ entityType: "VENDOR", name: "A", url: URL, personalNote: NOTE });
    expect(r.html).toContain(
      '<a href="https://meetmeatthefair.com/vendors/acme-crafts">https://meetmeatthefair.com/vendors/acme-crafts</a>.'
    );
  });

  it("text part: note, bare claim URL, 14-day line, sign-off — in that order", () => {
    const r = renderInviteEmail({
      entityType: "PROMOTER",
      name: "A",
      url: URL,
      personalNote: NOTE,
    });
    expect(r.text.startsWith("Hi Jane,")).toBe(true);
    expect(before(r.text, "See you there!", URL)).toBe(true);
    expect(before(r.text, URL, FOURTEEN_DAY_LINE)).toBe(true);
    expect(r.text.endsWith("John\nhttps://meetmeatthefair.com")).toBe(true);
  });

  it("subject override; and with neither note nor subject the output is identical to the default", () => {
    expect(
      renderInviteEmail({ entityType: "VENDOR", name: "A", url: URL, subject: "Great to meet you" })
        .subject
    ).toBe("Great to meet you");
    for (const entityType of ["VENDOR", "PROMOTER", "PERFORMER"] as const) {
      const base = renderInviteEmail({ entityType, name: "A", url: URL });
      expect(
        renderInviteEmail({ entityType, name: "A", url: URL, personalNote: "  ", subject: "" })
      ).toEqual(base);
      expect(
        renderInviteEmail({ entityType, name: "A", url: URL, personalNote: null, subject: null })
      ).toEqual(base);
    }
  });

  it("live send with a note: one email, note above button, flags recorded on outreach + audit", async () => {
    const json = await invoke({
      entity_type: "VENDOR",
      entity_id: "v-1",
      personal_note: NOTE,
      subject: "Kittery",
    });
    expect(json.created).toBe(true);
    const primary = sent.filter((m) => m.source === "email:claim-invite");
    expect(primary).toHaveLength(1);
    expect(primary[0].subject).toBe("Kittery");
    expect(before(primary[0].html, "We met at the Kittery expo", "Claim your page")).toBe(true);
    const [attempt] = await db.select().from(vendorOutreachAttempts);
    expect(attempt.notes).toBe("create_claim_invite (personal note)");
    const [action] = await db.select().from(adminActions);
    expect(JSON.parse(action.payloadJson ?? "{}")).toMatchObject({
      personalNote: true,
      subjectOverride: true,
    });
  });

  it("resend + personal_note: revokes the live token and sends the note with a fresh link", async () => {
    await invoke({ entity_type: "VENDOR", entity_id: "v-1" });
    const first = sent[0].html;
    const json = await invoke({
      entity_type: "VENDOR",
      entity_id: "v-1",
      resend: true,
      personal_note: NOTE,
    });
    expect(json).toMatchObject({ created: true, reissued: true });
    const second = sent.filter((m) => m.source === "email:claim-invite")[1];
    expect(second.html).toContain("We met at the Kittery expo");
    expect(second.html).not.toBe(first);
    expect(await db.select().from(claimTokens)).toHaveLength(1);
  });
});

describe("OPE-1507 — dry_run", () => {
  it("ACCEPTANCE: renders the email and writes NOTHING — no token, no send, no outreach, no audit", async () => {
    // Positive control first: the same call without dry_run DOES write all four.
    // (Fresh DB per test, so the control cannot leak into the assertion below.)
    const json = await invoke({
      entity_type: "VENDOR",
      entity_id: "v-1",
      personal_note: "Hello from the expo.",
      dry_run: true,
    });
    expect(json).toMatchObject({
      dry_run: true,
      would_send: true,
      to: "owner@acme.test",
      personalNote: true,
      subject: "Claim your free listing on Meet Me at the Fair",
    });
    expect(String(json.body_html)).toContain("Hello from the expo.");
    expect(String(json.body_html)).toContain(DRY_RUN_TOKEN_PLACEHOLDER);
    expect(String(json.body_text)).toContain(DRY_RUN_TOKEN_PLACEHOLDER);
    // The unsubscribe footer is the real one.
    expect(String(json.body_html)).toMatch(/unsubscribe/i);
    // No 64-hex raw token anywhere in the result.
    expect(JSON.stringify(json)).not.toMatch(/[0-9a-f]{64}/);
    expect(sent).toHaveLength(0);
    expect(await db.select().from(claimTokens)).toHaveLength(0);
    expect(await db.select().from(vendorOutreachAttempts)).toHaveLength(0);
    expect(await db.select().from(adminActions)).toHaveLength(0);
  });

  it("positive control: the identical call without dry_run writes token, sends, outreach and audit", async () => {
    await invoke({
      entity_type: "VENDOR",
      entity_id: "v-1",
      personal_note: "Hello from the expo.",
    });
    expect(sent.length).toBeGreaterThan(0);
    expect(await db.select().from(claimTokens)).toHaveLength(1);
    expect(await db.select().from(vendorOutreachAttempts)).toHaveLength(1);
    expect(await db.select().from(adminActions)).toHaveLength(1);
  });

  it("a dry run against a live invite says the real call would no-op (unless resend)", async () => {
    await invoke({ entity_type: "VENDOR", entity_id: "v-1" });
    const tokensBefore = await db.select().from(claimTokens);
    const json = await invoke({ entity_type: "VENDOR", entity_id: "v-1", dry_run: true });
    expect(json).toMatchObject({
      dry_run: true,
      would_send: false,
      reason: "active_invite_exists",
    });
    expect(await db.select().from(claimTokens)).toEqual(tokensBefore);
    const withResend = await invoke({
      entity_type: "VENDOR",
      entity_id: "v-1",
      dry_run: true,
      resend: true,
    });
    expect(withResend.would_send).toBe(true);
    expect(await db.select().from(claimTokens)).toEqual(tokensBefore);
  });

  it("dry run still honours the gates: an already-claimed listing is refused", async () => {
    db.update(vendors).set({ claimed: true }).run();
    const res = (await server.invoke("create_claim_invite", {
      entity_type: "VENDOR",
      entity_id: "v-1",
      dry_run: true,
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });
});

describe("OPE-1507 — free-text boundary", () => {
  it("an entity-encoded note is decoded once, then escaped once — the reader sees '&', not '&amp;'", async () => {
    const json = await invoke({
      entity_type: "VENDOR",
      entity_id: "v-1",
      personal_note: "Crafts &amp; more",
      subject: "Fairs &amp; festivals",
      dry_run: true,
    });
    expect(String(json.body_html)).toContain("<p>Crafts &amp; more</p>");
    expect(String(json.body_html)).not.toContain("&amp;amp;");
    expect(json.subject).toBe("Fairs & festivals");
  });
});
