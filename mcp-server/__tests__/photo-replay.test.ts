/**
 * OPE-469 — the replay path, and the three things it must never do.
 *
 * Most of this file is about what does NOT happen. A replay runs against live
 * rows, so "it wrote nothing" and "it sent nothing" are the properties worth
 * pinning; that it produces a report is comparatively easy.
 *
 * The database is a real in-memory SQLite, so the reads are real reads. The R2
 * bucket and the vision model are stubbed, because the point under test is the
 * dry-run boundary — which writes are withheld — not whether Llama can see a
 * banner.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import { commitBlockedReason } from "../src/photo/replay.js";

const SCHEMA_SQL = `
  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY,
    subject TEXT, to_address TEXT, from_address TEXT,
    attachment_refs TEXT, attachment_count INTEGER DEFAULT 0,
    photos_stored INTEGER, resulting_event_id TEXT,
    reply_kind TEXT, flagged_for_review INTEGER DEFAULT 0,
    received_at INTEGER, status TEXT
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT,
    start_date INTEGER, end_date INTEGER, status TEXT, venue_id TEXT,
    series_id TEXT, merged_into TEXT
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT,
    latitude REAL, longitude REAL
  );
  CREATE TABLE event_days (
    id TEXT PRIMARY KEY, event_id TEXT, date INTEGER,
    internal_notes TEXT
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY, action TEXT, actor_user_id TEXT,
    target_type TEXT, target_id TEXT, payload_json TEXT, created_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

// The real `AttachmentRef` shape — `mimeType`, not `type`. `imageRefs` filters
// on it, so a fixture using the wrong key would report zero images and every
// test below would pass for the wrong reason.
const REFS = JSON.stringify([
  {
    key: "inbound-attachments/2026/08/booth-1.jpg",
    name: "booth-1.jpg",
    mimeType: "image/jpeg",
    size: 1024,
  },
  {
    key: "inbound-attachments/2026/08/booth-2.jpg",
    name: "booth-2.jpg",
    mimeType: "image/jpeg",
    size: 2048,
  },
]);

/**
 * A vision stub returning the ALREADY-PARSED object shape Workers AI actually
 * emits for this model (measured in prod 2026-08-16 — `response` is an object,
 * not a JSON string). Using the real shape matters: a stub returning a string
 * would be parsed as "nothing usable", the pipeline would stage nothing, and
 * every "wrote nothing" assertion below would pass without exercising anything.
 */
const ai = {
  run: vi.fn(async () => ({
    response: {
      kind: "booth",
      business_name: "Paul Menice Images",
      website: null,
      products: ["photography"],
      confidence: 0.6,
      rationale: "Banner reads Paul Menice Images",
    },
  })),
};

/** A minimal R2 stub — one-pixel-ish bytes, enough to be read and passed on. */
const bucket = {
  get: vi.fn(async (key: string) => ({
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, key.length]).buffer,
  })),
};

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  bucket.get.mockClear();
  ai.run.mockClear();

  raw
    .prepare(
      `INSERT INTO inbound_emails
       (id, subject, to_address, attachment_refs, attachment_count,
        photos_stored, resulting_event_id, reply_kind, flagged_for_review)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      "e-known",
      "Photos from Ellsworth",
      // The plus-address override — `parsePlusSegment` reads `ellsworth-fair`
      // and the resolver looks it up by slug. Deterministic, unlike relying on
      // EXIF GPS in a fixture with no real JPEG behind it.
      "photos+ellsworth-fair@meetmeatthefair.com",
      REFS,
      2,
      2,
      "ev-1",
      "photo-intake-ack",
      0
    );

  raw
    .prepare(`INSERT INTO events (id, slug, name, status, venue_id) VALUES (?,?,?,?,?)`)
    .run("ev-1", "ellsworth-fair", "Ellsworth Fair", "APPROVED", "v-1");
  raw
    .prepare(`INSERT INTO venues (id, name, city, state) VALUES (?,?,?,?)`)
    .run("v-1", "Ellsworth Fairgrounds", "Ellsworth", "ME");
});

describe("the commit gate", () => {
  it('refuses to commit unless REPLAY_COMMIT_ENABLED is exactly "true"', () => {
    // Same shape as PHOTO_VISION_ENABLED / ENRICHMENT_DRY_RUN elsewhere in this
    // codebase: an env flag, string-compared, default off. A committed replay
    // writes to live rows, so the operator flips a flag rather than the tool
    // trusting a boolean argument from a caller.
    expect(commitBlockedReason({})).toContain("REPLAY_COMMIT_ENABLED");
    expect(commitBlockedReason({ REPLAY_COMMIT_ENABLED: "false" })).toContain("gated off");
    expect(commitBlockedReason({ REPLAY_COMMIT_ENABLED: "1" })).not.toBeNull();
    expect(commitBlockedReason({ REPLAY_COMMIT_ENABLED: "TRUE" })).not.toBeNull();
    expect(commitBlockedReason({ REPLAY_COMMIT_ENABLED: "true" })).toBeNull();
  });

  it("says the dry run still completed, so a blocked commit is not a failure", () => {
    // The operator asked for a write and did not get one. If the message only
    // said "blocked", they would reasonably assume nothing ran and re-run it
    // with more force. It ran; only the writes were withheld.
    expect(commitBlockedReason({})).toContain("wrote nothing");
  });
});

describe("a dry run writes nothing", () => {
  it("leaves the inbound row byte-identical", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const before = raw.prepare(`SELECT * FROM inbound_emails WHERE id='e-known'`).get();

    await replayInboundAttachment(
      // No AI binding → the pipeline reports disabled and writes nothing, which
      // is itself one of the outcomes a replay exists to surface.
      { VENDOR_ASSETS: bucket, DB: raw } as never,
      db,
      { inboundEmailId: "e-known" }
    );

    const after = raw.prepare(`SELECT * FROM inbound_emails WHERE id='e-known'`).get();
    expect(after).toEqual(before);
  });

  it("stages no admin_actions row", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    await replayInboundAttachment(
      { VENDOR_ASSETS: bucket, DB: raw, PHOTO_VISION_ENABLED: "true" } as never,
      db,
      { inboundEmailId: "e-known" }
    );
    const count = raw.prepare(`SELECT COUNT(*) AS n FROM admin_actions`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("preserves the photos_stored fingerprint — NULL must not become 0", async () => {
    // The five 2026-08-15 emails are deliberately left at NULL: NULL means
    // "never tried", 0 means "tried and stored nothing", and only the second is
    // a defect the sweep should surface. Testing the lane must not destroy the
    // evidence of the original defect.
    raw
      .prepare(
        `INSERT INTO inbound_emails (id, subject, to_address, attachment_refs, attachment_count, photos_stored)
         VALUES (?,?,?,?,?,NULL)`
      )
      .run("e-fingerprint", "Fair photos", "photos@meetmeatthefair.com", REFS, 2);

    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment(
      { VENDOR_ASSETS: bucket, DB: raw, PHOTO_VISION_ENABLED: "true" } as never,
      db,
      { inboundEmailId: "e-fingerprint" }
    );

    const after = raw
      .prepare(`SELECT photos_stored FROM inbound_emails WHERE id='e-fingerprint'`)
      .get() as { photos_stored: number | null };
    expect(after.photos_stored).toBeNull();
    expect(report.dryRun).toBe(true);
    expect(report.original.photosStored).toBeNull();
  });
});

describe("the dry-run boundary, with vision actually running", () => {
  // These are the tests that matter. With no AI binding the pipeline
  // short-circuits as DISABLED and never reaches a write, so "nothing was
  // written" would be true for the wrong reason. Here vision runs, produces a
  // real identification, and the writes are withheld anyway.
  const liveEnv = () =>
    ({
      VENDOR_ASSETS: bucket,
      DB: raw,
      AI: ai,
      PHOTO_VISION_ENABLED: "true",
    }) as never;

  it("examines the photos and stages nothing", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment(liveEnv(), db, {
      inboundEmailId: "e-known",
      attachmentIndex: 0,
    });

    // Vision really ran…
    expect(ai.run).toHaveBeenCalled();
    expect(report.vision?.examined).toBe(1);
    expect(report.vision?.dryRun).toBe(true);
    expect(report.vision?.staged).toBe(1);
    expect(report.vision?.identifiedNames).toContain("Paul Menice Images");

    // …and nothing was written.
    const actions = raw.prepare(`SELECT COUNT(*) AS n FROM admin_actions`).get() as { n: number };
    expect(actions.n).toBe(0);
    const flagged = raw
      .prepare(`SELECT flagged_for_review FROM inbound_emails WHERE id='e-known'`)
      .get() as { flagged_for_review: number };
    expect(flagged.flagged_for_review).toBe(0);
  });

  it("the SAME inputs do write when the pipeline is not in dry-run", async () => {
    // The control. Without this, "dry run wrote nothing" is indistinguishable
    // from "this configuration never writes at all".
    const { runBoothPipeline } = await import("../src/photo/booth-pipeline.js");
    await runBoothPipeline(liveEnv(), db, "e-known", "ev-1", [
      { key: "inbound-attachments/2026/08/booth-1.jpg", name: "booth-1.jpg" },
    ]);

    const actions = raw.prepare(`SELECT COUNT(*) AS n FROM admin_actions`).get() as { n: number };
    expect(actions.n).toBe(1);
    const flagged = raw
      .prepare(`SELECT flagged_for_review FROM inbound_emails WHERE id='e-known'`)
      .get() as { flagged_for_review: number };
    expect(flagged.flagged_for_review).toBe(1);
  });

  it("reports what a committed run would write, in the operator's terms", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment(liveEnv(), db, {
      inboundEmailId: "e-known",
      attachmentIndex: 0,
    });
    const said = report.wouldWrite.join("\n");
    expect(said).toMatch(/admin_actions row\(s\) staging a booth/);
    expect(said).toContain("Paul Menice Images");
    expect(said).toContain("flagged_for_review = 1");
  });

  it("asking to commit without the env flag still runs, and says why it did not write", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment(liveEnv(), db, {
      inboundEmailId: "e-known",
      attachmentIndex: 0,
      commit: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.commitBlockedReason).toContain("REPLAY_COMMIT_ENABLED");
    expect(report.vision?.examined).toBe(1); // it still RAN
    const actions = raw.prepare(`SELECT COUNT(*) AS n FROM admin_actions`).get() as { n: number };
    expect(actions.n).toBe(0);
  });
});

describe("no replay can send mail — structurally, not by configuration", () => {
  it("never produces a replyKind, because it never returns into the workflow", async () => {
    // The live handler returns a `replyKind` and the workflow's send-reply step
    // acts on it. A replay never returns a HandlerResult, so there is no value
    // for anything to act on. Asserted rather than left to inspection, because
    // "there is no path" is exactly the claim that rots when someone later
    // wires the replay into the handler for code reuse.
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment(
      { VENDOR_ASSETS: bucket, DB: raw, PHOTO_VISION_ENABLED: "true" } as never,
      db,
      { inboundEmailId: "e-known" }
    );
    expect(report).not.toHaveProperty("replyKind");
    expect(report).not.toHaveProperty("replyParams");
    expect(report).not.toHaveProperty("status");
  });

  it("reports the ORIGINAL reply_kind without re-sending it", async () => {
    // The baseline travels with the report so a comparison does not require a
    // second lookup — but it is read, never re-fired.
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment({ VENDOR_ASSETS: bucket, DB: raw } as never, db, {
      inboundEmailId: "e-known",
    });
    expect(report.original.replyKind).toBe("photo-intake-ack");
  });
});

describe("selecting attachments", () => {
  it("replays every image attachment by default", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment({ VENDOR_ASSETS: bucket, DB: raw } as never, db, {
      inboundEmailId: "e-known",
    });
    expect(report.attachments.images).toBe(2);
    expect(report.attachments.replayed).toBe(2);
  });

  it("replays exactly one when an index is given", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment({ VENDOR_ASSETS: bucket, DB: raw } as never, db, {
      inboundEmailId: "e-known",
      attachmentIndex: 1,
    });
    expect(report.attachments.replayed).toBe(1);
    expect(report.attachments.keys).toEqual(["inbound-attachments/2026/08/booth-2.jpg"]);
  });

  it("names the range rather than silently replaying the wrong photo", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    await expect(
      replayInboundAttachment({ VENDOR_ASSETS: bucket, DB: raw } as never, db, {
        inboundEmailId: "e-known",
        attachmentIndex: 9,
      })
    ).rejects.toThrow(/out of range.*2 image/s);
  });
});

describe("errors vs results", () => {
  it("throws for an email that does not exist", async () => {
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    await expect(
      replayInboundAttachment({ VENDOR_ASSETS: bucket, DB: raw } as never, db, {
        inboundEmailId: "nope",
      })
    ).rejects.toThrow(/not found/);
  });

  it("throws for an email with no image attachments", async () => {
    raw
      .prepare(
        `INSERT INTO inbound_emails (id, subject, to_address, attachment_refs, attachment_count)
         VALUES (?,?,?,?,?)`
      )
      .run("e-noimg", "Just text", "photos@meetmeatthefair.com", "[]", 0);

    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    await expect(
      replayInboundAttachment({ VENDOR_ASSETS: bucket, DB: raw } as never, db, {
        inboundEmailId: "e-noimg",
      })
    ).rejects.toThrow(/no image attachments/);
  });

  it("treats a disabled vision model as a RESULT, not an error", async () => {
    // An operator running a replay to find out WHY nothing was stored is best
    // served by "vision was off" in the report. Throwing would make the tool
    // useless for the diagnosis it exists to perform.
    const { replayInboundAttachment } = await import("../src/photo/replay.js");
    const report = await replayInboundAttachment({ VENDOR_ASSETS: bucket, DB: raw } as never, db, {
      inboundEmailId: "e-known",
    });
    expect(report.dryRun).toBe(true);
    expect(report.wouldWrite.join(" ")).toMatch(/Nothing/);
  });
});
