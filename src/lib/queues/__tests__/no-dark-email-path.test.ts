/**
 * OPE-445 — a sender must not be able to be born dark.
 *
 * `sendEmail` routes to Resend, and `RESEND_API_KEY` is configured nowhere —
 * not wrangler.toml, not .env.example, not a Worker secret. So it has always
 * taken its stub branch: an `email_send_ledger` row with `status='stubbed'`,
 * `error=NULL`, and a normal return. Indistinguishable from a successful send.
 *
 * That is how 26 consecutive `indexnow:health` alerts vanished between
 * 2026-07-10 and 2026-08-10 (OPE-369). The alert that warns us an integration
 * has gone silent was itself silent for a month.
 *
 * OPE-369 rerouted the three known callers but left the path in place, so the
 * next sender written could be born dark the same way. This test is the thing
 * that stops that: it fails if a new direct `sendEmail` caller appears, or if
 * the removed fallback is reintroduced into `enqueueEmail`.
 *
 * Source-level, for the reason OPE-369 recorded about its own tests: a
 * behavioural test that asserts on `sendEmail` "would now pass while
 * delivering nothing". The property here is "this call does not appear", which
 * no amount of mocking can express.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const SRC = join(ROOT, "src");

/** The one module allowed to call sendEmail: its own definition. */
const ALLOWED = new Set([join(SRC, "lib", "email", "send.ts")]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Strip comments so a doc reference to `sendEmail(` isn't read as a call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("no code calls the dark sendEmail path", () => {
  it("has zero direct sendEmail() callers outside its own module", () => {
    const offenders = walk(SRC)
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => /\bsendEmail\s*\(/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.replace(ROOT + "/", ""));

    // If this fails, a sender was written against the path that stubs
    // silently. Route it through `enqueueEmail` instead — that reaches the
    // EMAIL_JOBS queue and the cf-email consumer that actually delivers.
    expect(offenders).toEqual([]);
  });

  it("enqueueEmail does not import sendEmail", () => {
    // The specific reintroduction to guard: restoring "Path 3" as a
    // convenience fallback. It cannot send, so it must not exist.
    const producers = readFileSync(join(SRC, "lib", "queues", "producers.ts"), "utf8");
    expect(producers).not.toMatch(/^import\s*\{[^}]*\bsendEmail\b/m);
  });

  it("enqueueEmail throws rather than returning quietly when no transport works", () => {
    // Deleting the fallback without replacing it would be worse than leaving
    // it: the function would return having done nothing at all. The throw is
    // the load-bearing part.
    const producers = stripComments(
      readFileSync(join(SRC, "lib", "queues", "producers.ts"), "utf8")
    );
    const enqueueEmailBody = producers.slice(
      producers.indexOf("export async function enqueueEmail"),
      producers.indexOf("export async function enqueueIndexNow")
    );
    expect(enqueueEmailBody).toMatch(/throw new Error/);
  });
});
