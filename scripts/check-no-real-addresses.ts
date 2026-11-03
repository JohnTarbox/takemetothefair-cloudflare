/**
 * OPE-1363 — no real person's email address in a tracked file.
 *
 * This repo is PUBLIC. Migration comments, code comments, a wrangler.toml
 * comment and dozens of test fixtures had been copied from real inbound mail
 * and real `users` rows, so real people's addresses at consumer mail
 * providers were published with the source. They were scrubbed to stand-ins;
 * this guard stops the next copy-paste from re-publishing one.
 *
 * Rule: any address at a consumer mail domain (gmail.com, yahoo.com,
 * aol.com, comcast.net and the like — see CONSUMER_DOMAINS) fails the build
 * unless its local part is an obvious fake (ALLOWED_LOCAL) or it is one of
 * John's own addresses (OWNER_ADDRESSES).
 *
 * Writing a fixture: keep the provider domain if the test depends on it
 * (free-mail handling, typo suggestions) and use a fake local part such as
 * `user.alder@gmail.com` or `test.vendor1@yahoo.com`. Otherwise use
 * example.com / example.org / example.net.
 *
 * Business-domain addresses (someone@somefair.org) cannot be judged
 * mechanically — a role address there is often public. Those stay a review
 * concern: never paste a person's address from a real email into a fixture.
 *
 * The output never prints the offending local part: the CI log of a public
 * repo is itself public.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Consumer / ISP mail domains. Lower-case, exact match on the domain. */
export const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.ca",
  "yahoo.co.uk",
  "ymail.com",
  "rocketmail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "live.ca",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "charter.net",
  "cox.net",
  "earthlink.net",
  "optonline.net",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "email.com",
  "roadrunner.com",
  "rr.com",
  "maine.rr.com",
  "twc.com",
  "myfairpoint.net",
  "fairpoint.net",
  "metrocast.net",
  "tds.net",
  "gwi.net",
  "frontier.com",
  "frontiernet.net",
  "rogers.com",
  "shaw.ca",
  "juno.com",
  "netzero.net",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
]);

/** Local parts that are obviously not a person. */
export const ALLOWED_LOCAL =
  /^(test|user|someone|example|fake|vendor|sender|noreply|no-reply|your)[\w.+-]*$/i;

/** John's own addresses, which appear in config and docs on purpose. */
export const OWNER_ADDRESSES = new Set(["jtarboxme@gmail.com"]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export interface Finding {
  file: string;
  line: number;
  domain: string;
}

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(EMAIL)) {
      const addr = m[0];
      const at = addr.lastIndexOf("@");
      const local = addr.slice(0, at);
      const domain = addr.slice(at + 1).toLowerCase();
      if (!CONSUMER_DOMAINS.has(domain)) continue;
      if (OWNER_ADDRESSES.has(addr.toLowerCase())) continue;
      if (ALLOWED_LOCAL.test(local)) continue;
      out.push({ file, line: i + 1, domain });
    }
  }
  return out;
}

function main(): void {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f && !f.startsWith("node_modules/") && f !== "package-lock.json");
  const findings: Finding[] = [];
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      continue; // deleted in the working tree, a submodule, etc.
    }
    if (buf.includes(0)) continue; // binary
    findings.push(...scanText(file, buf.toString("utf8")));
  }
  if (findings.length === 0) {
    console.log(`check-no-real-addresses: OK (${files.length} tracked files scanned)`);
    return;
  }
  console.error(
    `check-no-real-addresses: ${findings.length} address(es) at a consumer mail domain with a non-fake local part.\n` +
      `This repo is public. Replace each with a stand-in (user.alder@gmail.com, someone@example.com) — see the header of scripts/check-no-real-addresses.ts.\n`
  );
  for (const f of findings) console.error(`  ${f.file}:${f.line}  <redacted>@${f.domain}`);
  process.exit(1);
}

if (process.argv[1] && /check-no-real-addresses\.ts$/.test(process.argv[1])) main();
