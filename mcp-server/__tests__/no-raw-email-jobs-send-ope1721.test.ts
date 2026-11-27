/**
 * OPE-1721 — every `email-jobs` message from the MCP Worker goes through
 * `sendEmailJob` (src/email-jobs.ts), which spills an oversized body to D1 so
 * the message fits Cloudflare Queues' 128 KB limit (OPE-1719: the Nov 27
 * newsletter was refused at 136,334 bytes).
 *
 * Part 1 is a source scan: a raw `EMAIL_JOBS.send(` (also `!.` / `?.`) outside
 * the helper fails. Comments are stripped first so prose naming the old form
 * does not trip it. LANDMARK: the scan must also SEE the helper's call sites —
 * a scanner that silently stops matching files would otherwise report "no raw
 * sends" on an empty set.
 *
 * Part 2 pins the helper's three branches.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailJobBodies } from "../src/schema.js";

const harness: { db: TestDb } = { db: null as unknown as TestDb };
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
const { sendEmailJob } = await import("../src/email-jobs.js");

const SRC = join(__dirname, "../src");
const HELPER = "email-jobs.ts";
// 30 converted senders + the enqueue-email proxy on 2026-11-27. A floor, not an
// exact count: new senders raise it, and only a broken scan lowers it.
const MIN_HELPER_CALL_SITES = 31;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function scanRawSends(files: Array<{ path: string; src: string }>) {
  const raw: string[] = [];
  let helperCalls = 0;
  for (const { path, src } of files) {
    const code = stripComments(src);
    helperCalls += (code.match(/\bsendEmailJob\(/g) ?? []).length;
    if (path.endsWith(HELPER)) continue;
    code.split("\n").forEach((line, i) => {
      if (/EMAIL_JOBS\s*[!?]?\s*\.\s*send\s*\(/.test(line)) raw.push(`${path}:${i + 1}`);
    });
  }
  return { raw, helperCalls };
}

const sources = () =>
  walk(SRC).map((p) => ({ path: relative(SRC, p), src: readFileSync(p, "utf8") }));

describe("OPE-1721 — no raw EMAIL_JOBS.send outside the helper", () => {
  it("finds no raw send, and sees every helper call site (landmark)", () => {
    const { raw, helperCalls } = scanRawSends(sources());
    expect(raw).toEqual([]);
    expect(helperCalls).toBeGreaterThanOrEqual(MIN_HELPER_CALL_SITES);
  });

  it("goes red on a planted raw send, in all three spellings", () => {
    for (const planted of [
      "await env.EMAIL_JOBS.send({ to, subject });",
      "await env.EMAIL_JOBS!.send(msg);",
      "await this.env.EMAIL_JOBS?.send(msg);",
    ]) {
      const { raw } = scanRawSends([...sources(), { path: "planted.ts", src: planted }]);
      expect(raw).toEqual(["planted.ts:1"]);
    }
  });

  it("ignores the raw form inside comments", () => {
    const { raw } = scanRawSends([
      { path: "c.ts", src: "// was env.EMAIL_JOBS.send(x)\n/* env.EMAIL_JOBS.send(y) */" },
    ]);
    expect(raw).toEqual([]);
  });
});

describe("OPE-1721 — sendEmailJob", () => {
  beforeEach(() => {
    ({ db: harness.db } = createTestDb());
  });
  const queue = () => {
    const sent: Array<Record<string, unknown>> = [];
    return { sent, q: { send: async (m: Record<string, unknown>) => void sent.push(m) } };
  };

  it("sends a small message untouched, needing no DB", async () => {
    const { sent, q } = queue();
    const msg = { to: "a@example.com", subject: "s", html: "<p>x</p>", text: "x", source: "t" };
    await sendEmailJob(q, undefined, msg);
    expect(sent).toEqual([msg]);
  });

  it("spills an oversized body to D1 and sends the reference", async () => {
    const { sent, q } = queue();
    const html = "<p>row — row</p>".repeat(8_000);
    await sendEmailJob(q, {} as D1Database, {
      to: "a@example.com",
      subject: "s",
      html,
      text: "",
      source: "t",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toBe("");
    const rows = await harness.db.select().from(emailJobBodies);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sent[0].bodyRef);
    expect(rows[0].html).toBe(html);
  });

  it("refuses loudly when oversized with no DB to spill into", async () => {
    const { sent, q } = queue();
    const html = "<p>row — row</p>".repeat(8_000);
    await expect(
      sendEmailJob(q, undefined, { to: "a@example.com", subject: "s", html, text: "", source: "t" })
    ).rejects.toThrow(/no DB binding/);
    expect(sent).toHaveLength(0);
  });
});
