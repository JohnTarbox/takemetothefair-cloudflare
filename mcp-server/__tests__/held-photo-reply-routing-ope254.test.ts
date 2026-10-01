/**
 * OPE-254 criterion 2, failed live 2026-10-01 — a reply to a hold notice is
 * routed by its thread, not by what its words look like.
 *
 * The specimen, from prod rows: six photos held at 15:15–15:17Z. John replied
 * to the hold notice for `464fa643` at 15:20Z, exactly as it instructs:
 *
 *     Senior Expo
 *     Southern Maine Successful Aging Expo 2026
 *
 * Reply `a38d02bf` carried the held email's message-id in References. The
 * classifier called it `new_event` (`routing_source='classifier_override'`),
 * the submit pipeline failed prose extraction, and the held-photo resolver —
 * reachable only through the `correction` handler — never ran.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb } from "./setup-db.js";
import { heldPhotoReplyRouting } from "../src/email-handler.js";
import { resolveTargetEventFromReply } from "../src/photo/resolve-held-photos.js";
import { events, inboundEmails, promoters } from "../src/schema.js";
import type { Db } from "../src/db.js";
import type { D1Database } from "@cloudflare/workers-types";

const JOHN = "jtarboxme@gmail.com";
const HELD_MSG_ID = "<CAEv_qq=tiVa0Ne6GgBB8szumkNJ-i_0Mt=HejD2MLHUWezBZ+A@mail.gmail.com>";
const NOTICE_MSG_ID = "<e9gUuA0UVcH5JfjB6CocNYPF2VXeo1JbDIld@meetmeatthefair.com>";
/** a38d02bf's headers, verbatim. */
const REPLY = {
  fromAddr: JOHN,
  inReplyTo: NOTICE_MSG_ID,
  references: `${HELD_MSG_ID} ${NOTICE_MSG_ID}`,
  sessionId: "test",
};
const REPLY_BODY =
  "Senior Expo\nSouthern Maine Successful Aging Expo 2026\n\n\nPrint\n\n\nOn Thu, Oct 1, 2026, 11:17 Meet Me at the Fair <notify@meetmeatthefair.com>\nwrote:\n\n> Thanks — we received 1 photo for Meet Me at the Fair, but we couldn't work\n> out which fair they're from, so we've held them rather than guess.";

function seedHeld(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { from?: string; replyKind?: string; resultingEventId?: string | null } = {}
) {
  db.insert(inboundEmails)
    .values({
      id: "464fa643-8258-4bcb-b604-a3f974b84a73",
      receivedAt: new Date("2026-10-01T15:15:00Z"),
      createdAt: new Date("2026-10-01T15:15:00Z"),
      fromAddress: opts.from ?? JOHN,
      toAddress: "submit@meetmeatthefair.com",
      intent: "photo_intake",
      status: "replied",
      replyKind: opts.replyKind ?? "photo-intake-unresolved",
      resultingEventId: opts.resultingEventId ?? null,
      messageId: HELD_MSG_ID,
    } as typeof inboundEmails.$inferInsert)
    .run();
}

describe("a reply threaded to a held photo routes to the resolver's lane", () => {
  it("ACCEPTANCE: the specimen reply routes to correction, held_photo_reply — not the classifier", async () => {
    const { db } = createTestDb();
    seedHeld(db);

    const r = await heldPhotoReplyRouting(db, REPLY);
    expect(r).not.toBeNull();
    expect(r!.routed).toHaveLength(1);
    expect(r!.routed[0].intent).toBe("correction");
    expect(r!.routingSource).toBe("held_photo_reply");
    expect(r!.classifierVersion).toBeNull(); // the classifier did not run
    expect(r!.aggregateRationale).toContain("464fa643");
  });

  it("and the resolver that lane reaches names the right fair from the specimen body", async () => {
    // The other half of criterion 2: routing to the resolver is pointless if
    // it then cannot read "Southern Maine Successful Aging Expo 2026".
    const { db } = createTestDb();
    db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p-1" }).run();
    db.insert(events)
      .values({
        id: "d8ff0b93-c76d-4828-9d93-66409d7420cb",
        name: "Southern Maine Successful Aging Expo 2026",
        slug: "southern-maine-successful-aging-expo-2026",
        promoterId: "p-1",
        status: "APPROVED",
      } as typeof events.$inferInsert)
      .run();

    const hit = await resolveTargetEventFromReply(
      db as unknown as Db,
      "Re: your message",
      REPLY_BODY
    );
    expect(hit?.id).toBe("d8ff0b93-c76d-4828-9d93-66409d7420cb");
  });
});

describe("it routes ONLY what the resolver would accept — same predicate", () => {
  it("a reply from a different sender is left to the classifier", async () => {
    const { db } = createTestDb();
    seedHeld(db, { from: "someone-else@example.com" });
    expect(await heldPhotoReplyRouting(db, REPLY)).toBeNull();
  });

  it("a thread whose photo hold is already resolved is left to the classifier", async () => {
    const { db } = createTestDb();
    seedHeld(db, { resultingEventId: "d8ff0b93-c76d-4828-9d93-66409d7420cb" });
    expect(await heldPhotoReplyRouting(db, REPLY)).toBeNull();
  });

  it("a reply threaded to a non-photo email is left to the classifier", async () => {
    const { db } = createTestDb();
    seedHeld(db, { replyKind: "support-ack" });
    expect(await heldPhotoReplyRouting(db, REPLY)).toBeNull();
  });

  it("an unthreaded email never reaches the database", async () => {
    const throwing = {
      select: () => {
        throw new Error("must not query");
      },
      insert: () => {},
    } as unknown as Db;
    expect(
      await heldPhotoReplyRouting(throwing, {
        fromAddr: JOHN,
        inReplyTo: null,
        references: null,
        sessionId: "t",
      })
    ).toBeNull();
  });

  it("a lookup failure falls back to the classifier rather than bouncing the email", async () => {
    const broken = {
      select: () => {
        throw new Error("D1 down");
      },
      insert: () => ({ values: async () => {} }),
    } as unknown as D1Database & Db;
    expect(await heldPhotoReplyRouting(broken, REPLY)).toBeNull();
  });
});

describe("computeRouting consults it first (source-level)", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/email-handler.ts", import.meta.url)),
    "utf8"
  );
  const bodyAt = SRC.indexOf("async function computeRouting(");

  it("computeRouting exists where we look (else the ordering checks are inert)", () => {
    expect(bodyAt).toBeGreaterThan(-1);
  });

  it("the held-photo check runs before the trusted fast-path and before the classifier", () => {
    const body = SRC.slice(bodyAt);
    const held = body.indexOf("await heldPhotoReplyRouting(env.DB,");
    const fastpath = body.indexOf("const replyChainHeader = isReplyToOurThread(");
    const classifier = body.indexOf("classifyIntent(");
    expect(held).toBeGreaterThan(-1);
    expect(fastpath).toBeGreaterThan(-1);
    expect(classifier).toBeGreaterThan(-1);
    expect(held).toBeLessThan(fastpath);
    expect(held).toBeLessThan(classifier);
    expect(body.slice(held, held + 300)).toContain("if (heldPhotoReply) return heldPhotoReply;");
  });
});
