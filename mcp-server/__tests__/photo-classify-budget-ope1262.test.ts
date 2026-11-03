/**
 * OPE-1262 — a held photo must not fail outright on an optional OCR call.
 *
 * The specimen: 2026-10-01, `8c8c054e` (one 2.79 MB camera JPEG of a booth).
 * No GPS match, so it took the hold path, where `classifyAsPoster` sends the
 * image to extract-image. That call took 37–54s; the `dispatch` step's timeout
 * was 30s. The step timed out, its retry re-ran the slow call from scratch
 * (three calls for one photo), every attempt lost, and the email ended
 * `status='failed'` with `reply_kind NULL` — no reply, and nothing a reply
 * naming the fair could ever find.
 *
 * Three repairs, each pinned here against the real code:
 *   1. the classify call has its own budget, and losing it is a logged give-up
 *      that lets the hold proceed;
 *   2. a failed photo dispatch answers with the hold notice;
 *   3. that reply kind makes the failed row a held parent the reply→resolve
 *      path recovers.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb } from "./setup-db.js";
import {
  classifyAsPoster,
  photoIntakeFailureReply,
  POSTER_CLASSIFY_BUDGET_MS,
} from "../src/email-handlers/photo-intake.js";
import { buildReply } from "../src/email-reply-builder.js";
import { findHeldPhotoParents } from "../src/photo/resolve-held-photos.js";
import { errorLogs, inboundEmails } from "../src/schema.js";
import type { HandlerEnv } from "../src/email-handlers/types.js";

const IMAGE_REF = {
  key: "inbound-attachments/8c8c054e/0-IMG_0950.jpg",
  name: "IMG_0950.jpg",
  mimeType: "image/jpeg",
};

/** A booth photo's OCR: a description, a couple of banner words, no date. */
const BOOTH_OCR =
  "A booth table draped in a blue cloth. A banner behind it reads Waypoint Physical Therapy. " +
  "Brochures and a bowl of candy sit on the table.";

function envWith(fetchImpl: (req: Request) => Promise<Response>) {
  const { db } = createTestDb();
  const mainAppFetch = vi.fn(fetchImpl);
  const env = {
    DB: db,
    INTERNAL_API_KEY: "test-key",
    MAIN_APP_URL: "https://meetmeatthefair.com",
    MAIN_APP: { fetch: mainAppFetch },
    VENDOR_ASSETS: {
      get: async () => ({ arrayBuffer: async () => new ArrayBuffer(16) }),
    },
  } as unknown as HandlerEnv;
  return { env, db, mainAppFetch };
}

function classifyLogs(db: ReturnType<typeof createTestDb>["db"]) {
  return db
    .select()
    .from(errorLogs)
    .all()
    .filter((r) => r.source === "mcp:photo-intake:poster-classify");
}

describe("1. the classify call has a budget, and losing it lets the hold proceed", () => {
  it("ACCEPTANCE: a call slower than its budget gives up, logged, instead of hanging the step", async () => {
    // Never answers within the test — the specimen's 54s call, compressed.
    const { env, db, mainAppFetch } = envWith(() => new Promise<Response>(() => {}));

    const started = Date.now();
    const out = await classifyAsPoster(env, [IMAGE_REF], "8c8c054e", 50);
    const elapsed = Date.now() - started;

    expect(out).toBeNull(); // the caller falls through to the ordinary hold
    expect(elapsed).toBeLessThan(2_000); // bounded by the budget, not the call
    expect(mainAppFetch).toHaveBeenCalledTimes(1); // one call, never a retry

    const logs = classifyLogs(db);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe("poster classification skipped: budget exceeded");
    const ctx = JSON.parse(logs[0].context ?? "{}");
    expect(ctx).toMatchObject({
      messageRowId: "8c8c054e",
      reason: "budget exceeded",
      budgetMs: 50,
    });
  });

  it("landmark: a call that answers inside its budget still classifies, unchanged", async () => {
    const { env, db, mainAppFetch } = envWith(
      async () => new Response(JSON.stringify({ content: BOOTH_OCR }), { status: 200 })
    );

    const out = await classifyAsPoster(env, [IMAGE_REF], "464fa643", 5_000);

    expect(out).not.toBeNull();
    expect(out?.text).toBe(BOOTH_OCR);
    expect(out?.classification.verdict).not.toBe("POSTER");
    expect(mainAppFetch).toHaveBeenCalledTimes(1);
    const logs = classifyLogs(db);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toMatch(/^poster classification: /);
  });

  it("a non-OK answer inside the budget keeps its own reason — not 'budget exceeded'", async () => {
    const { env, db } = envWith(async () => new Response("boom", { status: 502 }));

    expect(await classifyAsPoster(env, [IMAGE_REF], "x", 5_000)).toBeNull();
    expect(classifyLogs(db)[0].message).toBe(
      "poster classification skipped: extract-image returned non-OK"
    );
  });

  it("the default budget covers every duration observed on 2026-10-01 (26–54s)", () => {
    expect(POSTER_CLASSIFY_BUDGET_MS).toBeGreaterThanOrEqual(54_000);
  });
});

describe("2. a failed photo dispatch answers the sender with the hold notice", () => {
  const failedRow = {
    subject: null,
    toAddress: "submit@meetmeatthefair.com",
    attachmentRefs: JSON.stringify([IMAGE_REF]),
    attachmentCount: 1,
  };

  it("ACCEPTANCE: the failure reply is the hold kind, with the photo count the row holds", () => {
    const r = photoIntakeFailureReply(failedRow);
    expect(r.replyKind).toBe("photo-intake-unresolved");
    expect(r.replyParams).toMatchObject({ photoCount: 1, holdReason: "dispatch-error" });
    expect(r.resultingEventId).toBeNull();
  });

  it("the copy says we failed — it does not send them to re-shoot for GPS", () => {
    const msg = buildReply(
      "photo-intake-unresolved",
      "jtarboxme@gmail.com",
      photoIntakeFailureReply(failedRow).replyParams ?? {}
    );
    expect(msg.text).toContain("we received 1 photo for Meet Me at the Fair");
    expect(msg.text).toContain("something went wrong on our side while reading the photos");
    expect(msg.text).toContain("Reply to this email naming the fair");
    expect(msg.text).not.toContain("no GPS data");
  });

  it("a plus-addressed fair hint survives into the params", () => {
    const r = photoIntakeFailureReply({
      ...failedRow,
      toAddress: "photos+southern-maine-successful-aging-expo@meetmeatthefair.com",
    });
    expect(r.replyParams?.eventHint).toBe("southern-maine-successful-aging-expo");
  });
});

describe("3. the failed row is recoverable by a reply naming the fair", () => {
  function seedRow(
    db: ReturnType<typeof createTestDb>["db"],
    id: string,
    status: string,
    replyKind: string | null
  ) {
    db.insert(inboundEmails)
      .values({
        id,
        receivedAt: new Date("2026-10-01T13:50:08Z"),
        fromAddress: "jtarboxme@gmail.com",
        toAddress: "submit@meetmeatthefair.com",
        intent: "photo_intake",
        status,
        replyKind,
        messageId: `<${id}@mail.gmail.com>`,
        attachmentRefs: JSON.stringify([IMAGE_REF]),
        attachmentCount: 1,
        createdAt: new Date("2026-10-01T13:50:08Z"),
      } as typeof inboundEmails.$inferInsert)
      .run();
  }

  it("ACCEPTANCE: a status='failed' row carrying the hold kind is found as a held parent", async () => {
    const { db } = createTestDb();
    seedRow(db, "8c8c054e", "failed", "photo-intake-unresolved");

    const parents = await findHeldPhotoParents(
      db,
      ["<8c8c054e@mail.gmail.com>"],
      "jtarboxme@gmail.com"
    );
    expect(parents.map((p) => p.id)).toEqual(["8c8c054e"]);
  });

  it("landmark: the pre-fix row shape (failed, reply_kind NULL) is NOT found — what the fix changes", async () => {
    const { db } = createTestDb();
    seedRow(db, "8c8c054e", "failed", null);

    expect(
      await findHeldPhotoParents(db, ["<8c8c054e@mail.gmail.com>"], "jtarboxme@gmail.com")
    ).toEqual([]);
  });
});

describe("the workflow wires it (source-level, like OPE-985)", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/workflows/inbound-email.ts", import.meta.url)),
    "utf8"
  );
  const dispatchAt = SRC.indexOf('"dispatch",\n');
  const dispatchBlock = SRC.slice(dispatchAt, dispatchAt + 2_500);

  it("the dispatch step exists where we are looking (else every check below is inert)", () => {
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(dispatchBlock).toContain("HANDLERS[intent");
  });

  it("photo_intake gets a step timeout that exceeds its classify budget", () => {
    const m = dispatchBlock.match(/intent === "photo_intake" \? "(\d+) seconds"/);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1000).toBeGreaterThan(POSTER_CLASSIFY_BUDGET_MS);
  });

  it("every dispatch retry is logged with its attempt number", () => {
    expect(dispatchBlock).toContain("stepCtx?.attempt");
    expect(dispatchBlock).toMatch(/dispatch retry: attempt \$\{attempt\}/);
  });

  it("the catch answers a photo with the hold notice — the call, not the import", () => {
    const catchAt = SRC.indexOf("message: `dispatch failed for intent=${intent}`");
    expect(catchAt).toBeGreaterThan(-1);
    const after = SRC.slice(catchAt, catchAt + 2_000);
    expect(after).toContain('if (intent === "photo_intake")');
    expect(after).toContain("photoIntakeFailureReply(row)");
  });
});
