/**
 * OPE-770 — the briefing, driven by the ticket's own replay cases.
 *
 * Real SQLite, because the interesting behaviour is entirely in the SQL: who
 * counts as external, how many times they have written, and what the newest
 * outbound was. A mock would return whatever it was handed for all three.
 *
 * The failure this is written against is NOT "the page is empty". It is the
 * page being *confidently* empty — half of `inbound_emails` is our own
 * notify@→alert@ traffic, so a filter that matched nothing and a genuinely
 * quiet week look identical unless the counts are reported beside the list.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { buildCorrespondentBriefing } from "../briefing";

const SCHEMA_SQL = `
  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL,
    from_address TEXT,
    to_address TEXT,
    subject TEXT,
    intent TEXT,
    status TEXT,
    matched_entity_type TEXT,
    matched_entity_id TEXT,
    match_basis TEXT,
    sender_auth TEXT
  );
  CREATE TABLE email_send_ledger (
    message_id TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL,
    recipient TEXT,
    source TEXT,
    provider_message_id TEXT,
    status TEXT
  );
`;

const NOW = new Date("2026-09-04T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3600_000);

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

function inbound(
  id: string,
  from: string,
  at: Date,
  over: Partial<{
    subject: string;
    intent: string;
    matchedEntityType: string;
    matchBasis: string;
    senderAuth: string;
  }> = {}
) {
  raw
    .prepare(
      `INSERT INTO inbound_emails
       (id, received_at, from_address, to_address, subject, intent, status,
        matched_entity_type, matched_entity_id, match_basis, sender_auth)
       VALUES (?,?,?, 'hello@meetmeatthefair.com', ?,?, 'received', ?, ?, ?, ?)`
    )
    .run(
      id,
      Math.floor(at.getTime() / 1000),
      from,
      over.subject ?? "hello",
      over.intent ?? "support",
      over.matchedEntityType ?? null,
      over.matchedEntityType ? "ent-1" : null,
      over.matchBasis ?? null,
      over.senderAuth ?? null
    );
}

function outbound(id: string, to: string, at: Date, source: string, status = "sent") {
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, status)
       VALUES (?,?,?,?,?)`
    )
    .run(id, Math.floor(at.getTime() / 1000), to, source, status);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

const build = (windowDays = 30) =>
  buildCorrespondentBriefing(db as never, { windowDays, now: NOW });

describe("the ticket's replay cases", () => {
  it("Katie: a stranger with a problem, in one line", async () => {
    // "gmail sender, no matched entity, no prior contact, first contact,
    // intent support. That is enough to see she is a stranger with a problem."
    inbound("k1", "katie@gmail.com", daysAgo(2), { intent: "support", matchBasis: "none" });
    const b = await build();
    const katie = b.rows.find((r) => r.fromAddress === "katie@gmail.com")!;
    expect(katie.isFirstContact).toBe(true);
    expect(katie.priorMessageCount).toBe(1);
    expect(katie.matchedEntityType).toBeNull();
    expect(katie.intent).toBe("support");
    expect(katie.lastOutboundAt).toBeNull();
  });

  it("Celina Daigle: matched vendor, prior messages, a human reply — the case John rebuilt by hand", async () => {
    for (let i = 0; i < 4; i++) {
      inbound(`c${i}`, "celina@example.com", daysAgo(20 + i), { matchedEntityType: "VENDOR" });
    }
    inbound("c-new", "celina@example.com", daysAgo(1), {
      matchedEntityType: "VENDOR",
      matchBasis: "domain",
    });
    outbound("o1", "celina@example.com", daysAgo(10), "reply:human");

    const b = await build();
    const celina = b.rows.find((r) => r.inboundEmailId === "c-new")!;
    expect(celina.priorMessageCount).toBe(5); // 4 prior + this one
    expect(celina.isFirstContact).toBe(false);
    expect(celina.matchedEntityType).toBe("VENDOR");
    expect(celina.lastOutboundSource).toBe("reply:human");
    expect(celina.ackOnly).toBe(false);
  });

  it("Carol Pace: a matched vendor whose ONLY outbound was an ack, ageing", async () => {
    inbound("p1", "carol@example.com", daysAgo(9), { matchedEntityType: "VENDOR" });
    outbound("o2", "carol@example.com", daysAgo(9), "reply:support-ack");

    const b = await build();
    const carol = b.rows.find((r) => r.fromAddress === "carol@example.com")!;
    expect(carol.ackOnly).toBe(true);
    expect(carol.waitingOnUs).toBe(true);
    expect(b.waiting.map((r) => r.fromAddress)).toContain("carol@example.com");
  });
});

describe("the waiting queue is a real queue, not the obligation count", () => {
  it("a human reply clears the wait even on an old message", async () => {
    inbound("h1", "someone@example.com", daysAgo(20));
    outbound("o3", "someone@example.com", daysAgo(19), "reply:human");
    const b = await build();
    expect(b.rows[0].waitingOnUs).toBe(false);
    expect(b.waiting).toHaveLength(0);
  });

  it("a FRESH auto-ack is not yet waiting — the 72h bound is real", async () => {
    inbound("f1", "fresh@example.com", hoursAgo(4));
    outbound("o4", "fresh@example.com", hoursAgo(4), "reply:support-ack");
    const b = await build();
    expect(b.rows[0].ackOnly).toBe(true);
    expect(b.rows[0].waitingOnUs).toBe(false);
  });

  it("never written to, and old enough, counts as waiting", async () => {
    inbound("n1", "ignored@example.com", daysAgo(5));
    const b = await build();
    expect(b.rows[0].waitingOnUs).toBe(true);
  });
});

describe("external filtering, with its landmark", () => {
  it("excludes our own alerting traffic and no-reply senders", async () => {
    inbound("s1", "notify@meetmeatthefair.com", daysAgo(1));
    inbound("s2", "noreply@notify.cloudflare.com", daysAgo(1));
    inbound("e1", "real@example.com", daysAgo(1));

    const b = await build();
    expect(b.rows.map((r) => r.fromAddress)).toEqual(["real@example.com"]);
    // The landmark: an empty-ish list is only readable next to what was scanned.
    expect(b.scannedTotal).toBe(3);
    expect(b.filteredSystemSenders).toBe(2);
  });

  it("reports scannedTotal even when NOTHING is external — quiet week vs broken filter", async () => {
    inbound("s3", "notify@meetmeatthefair.com", daysAgo(1));
    const b = await build();
    expect(b.rows).toHaveLength(0);
    expect(b.scannedTotal).toBe(1);
    expect(b.filteredSystemSenders).toBe(1);
  });
});

describe("facts only", () => {
  it("omits senderAuth entirely rather than fabricating a reassuring 'unknown'", async () => {
    inbound("a1", "noauth@example.com", daysAgo(1)); // sender_auth NULL
    inbound("a2", "hasauth@example.com", daysAgo(1), { senderAuth: "pass" });
    const b = await build();
    const noauth = b.rows.find((r) => r.fromAddress === "noauth@example.com")!;
    const hasauth = b.rows.find((r) => r.fromAddress === "hasauth@example.com")!;
    expect("senderAuth" in noauth).toBe(false);
    expect(hasauth.senderAuth).toBe("pass");
  });

  it("carries no generated prose field of any kind", async () => {
    inbound("g1", "x@example.com", daysAgo(1));
    const b = await build();
    const keys = Object.keys(b.rows[0]);
    // The hard line from the ticket, asserted structurally: if someone later
    // adds a drafted reply or a "what they want" summary, this fails and they
    // have to argue for it.
    for (const banned of ["suggestedReply", "draft", "summary", "confidence", "recommendation"]) {
      expect(keys).not.toContain(banned);
    }
    expect(keys.length).toBeGreaterThan(8); // and it does carry the facts
  });

  it("ignores a failed send when deciding the last outbound", async () => {
    // A send that failed is not a reply. Counting it would mark somebody
    // answered who never heard from us.
    inbound("x1", "failed@example.com", daysAgo(5));
    outbound("o5", "failed@example.com", daysAgo(4), "reply:human", "failed");
    const b = await build();
    expect(b.rows[0].lastOutboundAt).toBeNull();
    expect(b.rows[0].waitingOnUs).toBe(true);
  });
});
