/**
 * OPE-359 — audience separation for the newsletter archives.
 *
 * The invariant worth defending: a VENDOR issue must never appear in the public
 * consumer archive. Everything else here is secondary.
 *
 * Tested against real SQLite rather than mocked query builders, because the
 * failure mode is "the WHERE clause selected the wrong rows" and a mock returns
 * whatever you hand it. The same reasoning as the OPE-191 list tests: the risk
 * is which records come back, not which methods were called.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { newsletterIssues } from "@/lib/db/schema";

const SCHEMA_SQL = `
  CREATE TABLE newsletter_issues (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    sent_at INTEGER,
    audience TEXT NOT NULL DEFAULT 'weekend',
    created_at INTEGER
  );
`;

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

function issue(
  slug: string,
  audience: "weekend" | "vendor" | null,
  sentAt: number | null,
  subject = slug
) {
  if (audience === null) {
    // Exercise the column DEFAULT, not an explicit value.
    raw
      .prepare(
        `INSERT INTO newsletter_issues (id, slug, subject, html, sent_at) VALUES (?,?,?,?,?)`
      )
      .run(slug, slug, subject, "<p>x</p>", sentAt);
    return;
  }
  raw
    .prepare(
      `INSERT INTO newsletter_issues (id, slug, subject, html, sent_at, audience) VALUES (?,?,?,?,?,?)`
    )
    .run(slug, slug, subject, "<p>x</p>", sentAt, audience);
}

/** Mirrors the /newsletter index query. */
const consumerArchive = () =>
  db
    .select({ slug: newsletterIssues.slug })
    .from(newsletterIssues)
    .where(and(isNotNull(newsletterIssues.sentAt), eq(newsletterIssues.audience, "weekend")))
    .orderBy(desc(newsletterIssues.sentAt));

/** Mirrors the /newsletter/vendor index query. */
const vendorArchive = () =>
  db
    .select({ slug: newsletterIssues.slug })
    .from(newsletterIssues)
    .where(and(isNotNull(newsletterIssues.sentAt), eq(newsletterIssues.audience, "vendor")))
    .orderBy(desc(newsletterIssues.sentAt));

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the public consumer archive (OPE-359)", () => {
  it("NEVER lists a sent vendor issue — the whole point", async () => {
    issue("this-weekend-at-the-fair-jul-31", "weekend", 1000);
    issue("new-this-week-shows-just-added-2026-08-10", "vendor", 2000);

    const rows = await consumerArchive();
    expect(rows.map((r) => r.slug)).toEqual(["this-weekend-at-the-fair-jul-31"]);
  });

  it("still lists sent consumer issues", async () => {
    issue("this-weekend-at-the-fair-jul-31", "weekend", 2000);
    issue("this-weekend-at-the-fair-jul-24", "weekend", 1000);
    const rows = await consumerArchive();
    expect(rows.map((r) => r.slug)).toEqual([
      "this-weekend-at-the-fair-jul-31",
      "this-weekend-at-the-fair-jul-24",
    ]);
  });

  it("still excludes unsent issues, as it did before", async () => {
    // sent_at IS NULL means test send / composed-but-not-broadcast. That rule
    // predates this change and must survive it.
    issue("draft-issue", "weekend", null);
    expect(await consumerArchive()).toEqual([]);
  });
});

describe("the vendor archive", () => {
  it("lists sent vendor issues and nothing else", async () => {
    issue("new-this-week-shows-just-added-2026-08-10", "vendor", 2000);
    issue("this-weekend-at-the-fair-jul-31", "weekend", 1000);
    const rows = await vendorArchive();
    expect(rows.map((r) => r.slug)).toEqual(["new-this-week-shows-just-added-2026-08-10"]);
  });

  it("excludes a vendor issue that was only composed, never broadcast", async () => {
    // While VENDOR_DIGEST_SEND_ENABLED is off the Monday cron persists an issue
    // with sent_at NULL every week. Those are for John to read, not an archive.
    issue("new-this-week-shows-just-added-2026-08-10", "vendor", null);
    expect(await vendorArchive()).toEqual([]);
  });
});

describe("the column default is the SAFE direction", () => {
  it("an issue written without an audience defaults to weekend, not vendor", async () => {
    issue("legacy-issue", null, 1000);
    const rows = await consumerArchive();
    expect(rows.map((r) => r.slug)).toEqual(["legacy-issue"]);
  });

  it("so a forgetful writer over-shares a CONSUMER issue, never a vendor one", async () => {
    // This is why the default is 'weekend' rather than 'vendor' or NULL. The
    // failure mode of the default is "a consumer issue appears in the consumer
    // archive", which is where it belongs. The opposite default would leak
    // vendor mail onto a public page.
    issue("forgot-to-set-audience", null, 1000);
    expect((await vendorArchive()).map((r) => r.slug)).toEqual([]);
  });
});

describe("backfill rule", () => {
  it("matches the composer's slug stem, which is a constant, not the subject prose", async () => {
    // The migration keys on `new-this-week-shows-just-added-%`. Subjects carry a
    // count ("(4)") and are prose that can be reworded; the slug stem comes from
    // SUBJECT_STEM in the composer.
    issue("new-this-week-shows-just-added-2026-08-10", "weekend", 1000, "New This Week — (4)");
    raw
      .prepare(
        `UPDATE newsletter_issues SET audience='vendor' WHERE slug LIKE 'new-this-week-shows-just-added-%'`
      )
      .run();
    expect((await consumerArchive()).map((r) => r.slug)).toEqual([]);
    expect((await vendorArchive()).map((r) => r.slug)).toEqual([
      "new-this-week-shows-just-added-2026-08-10",
    ]);
  });

  it("leaves the historical weekend slugs alone", async () => {
    for (const s of [
      "this-weekend-at-the-fair-jul-31",
      "weekend-fair-digest-jul-17",
      "mmatf-preview-clean-copy",
    ]) {
      issue(s, "weekend", 1000);
    }
    raw
      .prepare(
        `UPDATE newsletter_issues SET audience='vendor' WHERE slug LIKE 'new-this-week-shows-just-added-%'`
      )
      .run();
    expect((await consumerArchive()).length).toBe(3);
    expect(await vendorArchive()).toEqual([]);
  });
});
