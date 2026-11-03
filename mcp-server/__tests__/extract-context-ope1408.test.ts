/**
 * OPE-1408 — `inbound_emails.content_length_chars` / `content_sha256_first16`
 * were NULL on every row since 2026-08-24.
 *
 * The writer (K7.4, `submit/persist-extract-context`) lived only in the
 * single-URL submit path. The multi-source fan-out (OPE-55, 2026-07-02) fetches
 * and extracts URLs too and never called it; OPE-537 (#1019, 2026-08-24) routed
 * every bare-URL email into the fan-out, which left the single-URL path with no
 * prod traffic. Prod: last non-NULL row 2496a417 at 2026-08-24 15:22:11 UTC;
 * July — the first fan-out month — has 0 of 5 URL extracts with the column set.
 *
 * Two layers here:
 *   1. the writer itself, against a real (better-sqlite3) inbound_emails row;
 *   2. the WIRING — keyed on the act, not the fix: every `submitExtract(…,
 *      fetched, …)` call in the workflow must be preceded, after its fetch, by
 *      `persistExtractContextStep(`. The Workflow class needs a live
 *      WorkflowStep binding, so this is source-level, scoped per call site.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createTestDb } from "./setup-db";
import { computeExtractContext, persistExtractContext } from "../src/workflows/extract-context.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const WORKFLOW = readFileSync(join(SRC_DIR, "workflows/inbound-email.ts"), "utf8");

function insertRow(raw: ReturnType<typeof createTestDb>["raw"], id: string) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, parsed_url)
       VALUES (?, ?, ?, 'a@example.com', 'events@meetmeatthefair.com', 'submit', 'https://example.com/e')`
    )
    .run(id, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
}

describe("persistExtractContext — the writer", () => {
  it("writes length + first 16 hex of SHA-256 onto the row", async () => {
    const { db, raw } = createTestDb();
    insertRow(raw, "row-1");
    insertRow(raw, "row-2");
    const content = "Vermont Crafters Expo — November 7, 2026. Café ✓";

    const ctx = await persistExtractContext(db as never, "row-1", content);

    const expectedHash = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
    expect(ctx).toEqual({ contentLengthChars: content.length, contentSha256First16: expectedHash });
    const r1 = raw
      .prepare(
        "SELECT content_length_chars, content_sha256_first16 FROM inbound_emails WHERE id = ?"
      )
      .get("row-1") as { content_length_chars: number; content_sha256_first16: string };
    expect(r1.content_length_chars).toBe(content.length);
    expect(r1.content_sha256_first16).toBe(expectedHash);
    // Only the targeted row.
    const r2 = raw
      .prepare("SELECT content_length_chars FROM inbound_emails WHERE id = ?")
      .get("row-2") as { content_length_chars: number | null };
    expect(r2.content_length_chars).toBeNull();
  });

  it("records an EMPTY page as 0, not NULL — that is the signal, not a miss", async () => {
    // 6ac06a0e (2026-08-24) is the real specimen: a 0-char fetch whose
    // extract failed. NULL would read as "the writer never ran".
    const { db, raw } = createTestDb();
    insertRow(raw, "row-empty");
    await persistExtractContext(db as never, "row-empty", "");
    const r = raw
      .prepare(
        "SELECT content_length_chars, content_sha256_first16 FROM inbound_emails WHERE id = ?"
      )
      .get("row-empty") as { content_length_chars: number | null; content_sha256_first16: string };
    expect(r.content_length_chars).toBe(0);
    expect(r.content_sha256_first16).toBe("e3b0c44298fc1c14");
  });

  it("identical content hashes identically (the clustering contract)", async () => {
    const a = await computeExtractContext("same page");
    const b = await computeExtractContext("same page");
    const c = await computeExtractContext("same page!");
    expect(a.contentSha256First16).toBe(b.contentSha256First16);
    expect(a.contentSha256First16).not.toBe(c.contentSha256First16);
    expect(a.contentSha256First16).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("wiring — every URL extract persists its context first", () => {
  /** Each `submitExtract(this.env, fetched, …)` site with the source since its nearest preceding fetch. */
  function extractSites(): Array<{ line: number; sinceFetch: string }> {
    const sites: Array<{ line: number; sinceFetch: string }> = [];
    const re = /submitExtract\(this\.env, fetched,/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(WORKFLOW))) {
      const fetchAt = WORKFLOW.lastIndexOf("submitFetch(", m.index);
      expect(fetchAt).toBeGreaterThan(-1);
      sites.push({
        line: WORKFLOW.slice(0, m.index).split("\n").length,
        // Line comments stripped: a commented-out call must not count
        // (it did, the first time this guard was driven to failure).
        sinceFetch: WORKFLOW.slice(fetchAt, m.index).replace(/^\s*\/\/.*$/gm, ""),
      });
    }
    return sites;
  }

  it("finds every URL extract site — the scan is not vacuous", () => {
    // single-URL submit path, multi-source fan-out, multi-URL pipeline.
    expect(extractSites().length).toBe(3);
  });

  it("each site calls persistExtractContextStep between its fetch and the AI call", () => {
    const missing = extractSites()
      .filter((s) => !s.sinceFetch.includes("persistExtractContextStep("))
      .map((s) => `inbound-email.ts:${s.line}`);
    expect(missing).toEqual([]);
  });

  it("the step helper actually calls the writer", () => {
    const start = WORKFLOW.indexOf("private async persistExtractContextStep(");
    expect(start).toBeGreaterThan(-1);
    const body = WORKFLOW.slice(start, WORKFLOW.indexOf("\n  }\n", start));
    expect(body).toContain("persistExtractContext(getDb(this.env.DB), messageRowId, content)");
  });

  it("the columns have exactly ONE writer in mcp-server/src (no parallel path to drift)", () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /contentLengthChars\s*:/.test(readFileSync(p, "utf8"))) {
          writers.push(p.slice(SRC_DIR.length + 1));
        }
      }
    };
    walk(SRC_DIR);
    expect(writers).toEqual(["workflows/extract-context.ts"]);
  });
});
