/**
 * OPE-1265 — lists@ / lists+<promoter-slug>@: MMATF's own address for promoter
 * mailing lists. Attributed by the plus-tag, confirmation mails held with their
 * link exposed (never fetched), and NOTHING arriving here ever draws a reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  inboundEmails,
  promoterListArrivals,
  promoterListSubscriptions,
  promoters,
} from "../src/schema.js";

const harness: { db: TestDb } = { db: null as unknown as TestDb };
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
const { handle, extractConfirmUrl, looksLikeConfirmation } =
  await import("../src/email-handlers/list-subscription.js");
const { registerListSubscriptionTools, listHealth } =
  await import("../src/tools/admin-list-subscriptions.js");
const { resolveIntent, shouldForwardToAdmin } = await import("../src/email-intents.js");
const { FANOUT_REPLY_RANK } = await import("../src/email-handlers/fanout-reply-leader.js");

const MLF = "e892bbce-780c-48a6-9143-14f644ca7f1f";
const MLF_SLUG = "maine-lobster-festival";
let db: TestDb;
let n = 0;

beforeEach(() => {
  ({ db } = createTestDb());
  harness.db = db;
  db.insert(promoters)
    .values({ id: MLF, companyName: "Maine Lobster Festival", slug: MLF_SLUG } as never)
    .run();
});

function inbound(over: {
  to: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string | null;
}) {
  const id = `ie-${++n}`;
  const row = {
    id,
    receivedAt: new Date(),
    createdAt: new Date(),
    fromAddress: over.from ?? "news@mail.mainelobsterfestival.com",
    toAddress: over.to,
    subject: over.subject ?? "Festival news",
    bodyText: over.text ?? "This summer's lineup is out.",
    bodyTextExcerpt: (over.text ?? "This summer's lineup is out.").slice(0, 500),
    bodyHtml: over.html ?? null,
    intent: "list_subscription",
    status: "received",
    attachmentCount: 0,
  };
  db.insert(inboundEmails)
    .values(row as never)
    .run();
  return db.select().from(inboundEmails).where(eq(inboundEmails.id, id)).all()[0];
}

const run = (row: Parameters<typeof handle>[2]) =>
  handle(
    { DB: {} } as never,
    { sessionId: "s", senderTrust: "unknown", emailAuth: "pass" } as never,
    row
  );

function seedSub(
  status: "requested" | "confirmed" | "active",
  address = `lists+${MLF_SLUG}@meetmeatthefair.com`
) {
  db.insert(promoterListSubscriptions)
    .values({
      id: `sub-${status}`,
      promoterId: MLF,
      address,
      status,
      requestedAt: new Date("2026-10-01T00:00:00Z"),
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z"),
    } as never)
    .run();
}

const arrivals = () => db.select().from(promoterListArrivals).all();
const sub = (id: string) =>
  db.select().from(promoterListSubscriptions).where(eq(promoterListSubscriptions.id, id)).all()[0];

describe("routing — the address is the fact", () => {
  it("lists@ and lists+<slug>@ both resolve to list_subscription, and neither forwards to admin", () => {
    expect(resolveIntent(`lists+${MLF_SLUG}@meetmeatthefair.com`)).toBe("list_subscription");
    expect(resolveIntent("LISTS@meetmeatthefair.com")).toBe("list_subscription");
    expect(shouldForwardToAdmin("list_subscription")).toBe(false);
    // Landmark: a different address is unaffected.
    expect(resolveIntent("submit@meetmeatthefair.com")).toBe("submit");
  });
});

describe("ACCEPTANCE — attribution by plus-tag, and nothing is sent", () => {
  it("lists+maine-lobster-festival@ is attributed to the promoter with basis subscription-address", async () => {
    seedSub("active");
    const r = await run(inbound({ to: `lists+${MLF_SLUG}@meetmeatthefair.com` }));
    expect(r.replyKind).toBeNull();
    expect(r.status).toBe("held");
    expect(arrivals()[0]).toMatchObject({
      promoterId: MLF,
      matchBasis: "subscription-address",
      plusTag: MLF_SLUG,
      kind: "issue",
      subscriptionId: "sub-active",
    });
  });

  it("an unknown plus-tag is stored unattributed and sends nothing", async () => {
    const r = await run(inbound({ to: "lists+no-such-promoter@meetmeatthefair.com" }));
    expect(r.replyKind).toBeNull();
    expect(arrivals()[0]).toMatchObject({
      promoterId: null,
      matchBasis: "unattributed",
      plusTag: "no-such-promoter",
    });
  });

  it("plain lists@ (a form that rejects '+') is stored unattributed — OPE-1264's domain match takes it from there", async () => {
    await run(inbound({ to: "lists@meetmeatthefair.com" }));
    expect(arrivals()[0]).toMatchObject({ matchBasis: "unattributed", plusTag: null });
  });
});

describe("ACCEPTANCE — a double-opt-in confirmation is held, its link readable, never fetched", () => {
  const CONFIRM_HTML = `<p>Please confirm your subscription to Maine Lobster Festival news.</p>
    <a href="https://mainelobsterfestival.us1.list-manage.com/subscribe/confirm?u=abc&amp;id=def&amp;e=123">Yes, subscribe me</a>
    <a href="https://mainelobsterfestival.us1.list-manage.com/unsubscribe?u=abc">Unsubscribe</a>`;

  it("on a requested subscription, the confirmation is recognised and its confirm URL lands on arrival + registry", async () => {
    seedSub("requested");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await run(
      inbound({
        to: `lists+${MLF_SLUG}@meetmeatthefair.com`,
        subject: "Please Confirm Subscription",
        text: "Please confirm your subscription. Click the link below to confirm.",
        html: CONFIRM_HTML,
      })
    );
    expect(r.replyKind).toBeNull();
    const url =
      "https://mainelobsterfestival.us1.list-manage.com/subscribe/confirm?u=abc&id=def&e=123";
    expect(arrivals()[0]).toMatchObject({ kind: "confirmation", confirmUrl: url });
    expect(sub("sub-requested")).toMatchObject({
      confirmUrl: url,
      status: "requested",
      issueCount: 0,
    });
    // The link is exposed, never followed.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("the unsubscribe link is never mistaken for the confirm link", () => {
    expect(
      extractConfirmUrl('<a href="https://x.example/unsubscribe?confirm=1">Unsubscribe</a>', null)
    ).toBeNull();
  });

  it("once a list is confirmed, an issue that says 'please confirm your RSVP' is still an issue", async () => {
    seedSub("confirmed");
    await run(
      inbound({
        to: `lists+${MLF_SLUG}@meetmeatthefair.com`,
        text: "Volunteers: please confirm your subscription to the shift sign-up sheet by Friday.",
      })
    );
    expect(arrivals()[0].kind).toBe("issue");
    expect(looksLikeConfirmation(null, "Confirm your booth by Friday")).toBe(false);
  });
});

describe("ACCEPTANCE — registry round-trip through the MCP tools", () => {
  it("create requested → mark confirmed → an issue arrives → active, last_received_at and count move", async () => {
    const server = new CapturingMcpServer();
    registerListSubscriptionTools(
      server as never,
      db as never,
      { userId: "u", role: "ADMIN" } as never
    );
    const created = JSON.parse(
      (
        (await server.invoke("create_list_subscription", {
          promoter_slug: MLF_SLUG,
          signup_url: "https://mainelobsterfestival.com/newsletter",
        })) as { content: { text: string }[] }
      ).content[0].text
    );
    expect(created.created).toBe(true);
    expect(created.subscription).toMatchObject({
      address: `lists+${MLF_SLUG}@meetmeatthefair.com`,
      status: "requested",
      lastReceivedAt: null,
    });
    const id = created.subscription.id as string;

    await server.invoke("update_list_subscription", { id, status: "confirmed" });
    expect(sub(id).status).toBe("confirmed");
    expect(sub(id).confirmedAt).not.toBeNull();

    await run(inbound({ to: `lists+${MLF_SLUG}@meetmeatthefair.com` }));
    expect(sub(id)).toMatchObject({ status: "active", issueCount: 1 });
    expect(sub(id).lastReceivedAt).not.toBeNull();

    // Idempotent create: the same (promoter, address) is not duplicated.
    const again = JSON.parse(
      (
        (await server.invoke("create_list_subscription", { promoter_slug: MLF_SLUG })) as {
          content: { text: string }[];
        }
      ).content[0].text
    );
    expect(again.already_existed).toBe(true);
    expect(db.select().from(promoterListSubscriptions).all()).toHaveLength(1);
  });

  it("a sender domain this subscription has never seen is recorded as a possible shared list", async () => {
    seedSub("active");
    await run(inbound({ to: `lists+${MLF_SLUG}@meetmeatthefair.com`, from: "news@mlf.example" }));
    await run(
      inbound({ to: `lists+${MLF_SLUG}@meetmeatthefair.com`, from: "deals@spammy-broker.example" })
    );
    expect(arrivals().map((a) => a.senderMismatch)).toEqual([0, 1]);
  });
});

describe("health — days since last issue against the list's own cadence", () => {
  const day = 86_400_000;
  const t0 = new Date("2026-09-01T00:00:00Z").getTime();
  it("a weekly list silent for 20 days is silent; for 10 days it is not", () => {
    const weekly = [t0, t0 + 7 * day, t0 + 14 * day, t0 + 21 * day];
    const last = new Date(t0 + 21 * day);
    expect(listHealth(weekly, last, new Date(last.getTime() + 20 * day))).toMatchObject({
      typicalGapDays: 7,
      silent: true,
    });
    expect(listHealth(weekly, last, new Date(last.getTime() + 10 * day)).silent).toBe(false);
  });
  it("too little history is never called silent", () => {
    expect(listHealth([t0], new Date(t0), new Date(t0 + 300 * day))).toMatchObject({
      typicalGapDays: null,
      silent: false,
    });
  });
});

describe("ACCEPTANCE — no reply path is reachable for these recipients (source-level)", () => {
  const HANDLER = readFileSync(`${__dirname}/../src/email-handler.ts`, "utf8");
  const LANE = readFileSync(`${__dirname}/../src/email-handlers/list-subscription.ts`, "utf8");

  it("the handler's only return is replyKind: null", () => {
    expect(LANE.match(/replyKind:/g)).toEqual(["replyKind:"]);
    expect(LANE).toContain("replyKind: null,");
  });

  it("the address is bound before the classifier and before the trusted fast-path", () => {
    const body = HANDLER.slice(HANDLER.indexOf("async function computeRouting("));
    const bound = body.indexOf('if (addressIntent === "list_subscription") {');
    expect(bound).toBeGreaterThan(-1);
    expect(bound).toBeLessThan(body.indexOf("const replyChainHeader = isReplyToOurThread("));
    expect(bound).toBeLessThan(body.indexOf("classifyIntent("));
  });

  it("the automated-mail and burst holds do not swallow list mail first", () => {
    const at = HANDLER.indexOf(
      'const isListAddress = resolveIntent(toAddr) === "list_subscription";'
    );
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(HANDLER.indexOf("detectAutomatedMail({"));
    expect(HANDLER).toContain("if (burst.tripped && !isListAddress) {");
  });

  it("it can never be the child that speaks for a multi-intent fan-out", () => {
    expect(FANOUT_REPLY_RANK.list_subscription).toBe(0);
  });
});
