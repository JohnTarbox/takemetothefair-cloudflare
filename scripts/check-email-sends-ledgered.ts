#!/usr/bin/env tsx
/**
 * OPE-319 — Guard: every direct outbound-email send site must also ledger.
 *
 * Why a BUILD-TIME guard rather than the runtime probe the ticket asked for:
 * "detect an outbound send with no ledger row" is not observable. An unledgered
 * send is, by definition, one that left no record — there is nothing to join
 * against and nothing to count. A probe could only ever confirm the sends we
 * already know about.
 *
 * So the guarantee is made structural instead. `email_send_ledger` answers
 * "did we email this person, and did it go out?" — the OPE-152 admin viewer and
 * every audit of an agent's contact with an outsider read it. A send path that
 * skips it is invisible to all of them, which is precisely how Carol's reply
 * became un-auditable (OPE-151).
 *
 * Today both MCP send paths ledger correctly: the EMAIL_JOBS queue consumer,
 * and the inbound-email workflow's direct `env.EMAIL.send`. Coverage is
 * per-path though — it holds because each author remembered. This makes
 * forgetting fail the build.
 *
 * Usage: npx tsx scripts/check-email-sends-ledgered.ts
 * Exits 0 if clean, 1 with the offending files.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MCP_SRC = resolve(ROOT, "mcp-server/src");

/**
 * A direct send to the Cloudflare Email binding. This is the call that actually
 * puts a message in front of an external human; enqueueing onto EMAIL_JOBS is
 * NOT matched, because the queue consumer ledgers centrally on the way out.
 */
const DIRECT_SEND_RE =
  /\benv\s*\.\s*EMAIL\s*\.\s*send\s*\(|\bthis\s*\.\s*env\s*\.\s*EMAIL\s*\.\s*send\s*\(/;

/** The choke point that records the send. */
const LEDGER_RE = /\bledgerEmailSend\s*\(/;

/**
 * Files allowed to reference the send binding without ledgering — they define
 * or re-export the machinery rather than sending.
 */
const ALLOWLIST = new Set(["mailer.ts", "queue-consumers.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const offenders: string[] = [];
for (const file of walk(MCP_SRC)) {
  const base = file.split("/").pop()!;
  if (ALLOWLIST.has(base)) continue;
  // Strip comments first — a docstring that merely NAMES the send binding
  // (email-handler.ts describes the queue consumer's downstream call) is not a
  // send site, and flagging it would train people to ignore this guard.
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  if (DIRECT_SEND_RE.test(src) && !LEDGER_RE.test(src)) {
    offenders.push(relative(ROOT, file));
  }
}

if (offenders.length > 0) {
  console.error(
    "\n✗ Outbound email send site(s) with no email_send_ledger write:\n" +
      offenders.map((f) => `   - ${f}`).join("\n") +
      "\n\n  Every message an agent sends to an external human must land in\n" +
      "  email_send_ledger, or it is invisible to the admin Email viewer and to\n" +
      "  any audit of who we contacted (OPE-151/OPE-319).\n\n" +
      "  Call ledgerEmailSend(db, {...}) alongside the send — see the\n" +
      "  inbound-email workflow's auto-reply for the shape.\n"
  );
  process.exit(1);
}

console.log("✓ every direct email send site also writes email_send_ledger");
