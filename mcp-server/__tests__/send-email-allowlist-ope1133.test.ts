/**
 * OPE-1133 — every sender the code uses is on the EMAIL binding's allowlist.
 *
 * `allowed_sender_addresses` makes an unlisted `from` THROW at send time. On
 * the queue path that means three retries and then the DLQ; on the workflow
 * path, a reply that never goes out. The failure is silent until someone
 * notices mail stopped. So the list and the code are pinned together here:
 * add a `*_FROM` constant without adding its address to wrangler.toml, and
 * this fails before it ships.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function allowlist(): string[] {
  const toml = readFileSync(join(ROOT, "mcp-server/wrangler.toml"), "utf8");
  const block = toml.slice(toml.indexOf("[[send_email]]"));
  const m = block.match(/allowed_sender_addresses\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].toLowerCase());
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every address assigned to a constant whose name ends in FROM. */
function senderConstants(): { file: string; address: string }[] {
  const found: { file: string; address: string }[] = [];
  for (const dir of ["mcp-server/src", "src/lib", "src/app"]) {
    for (const f of walk(join(ROOT, dir))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(
        /\b[A-Z_]*FROM\s*=\s*["'`]([^"'`]*@meetmeatthefair\.com)[^"'`]*["'`]/g
      )) {
        const addr = (m[1].match(/([a-z0-9._+-]+@meetmeatthefair\.com)/i) ?? [])[1];
        if (addr) found.push({ file: f.slice(ROOT.length + 1), address: addr.toLowerCase() });
      }
    }
  }
  return found;
}

describe("EMAIL binding sender allowlist", () => {
  it("is declared, and holds the three measured senders", () => {
    expect(allowlist().sort()).toEqual(
      [
        "hello@meetmeatthefair.com",
        "notify@meetmeatthefair.com",
        "support@meetmeatthefair.com",
      ].sort()
    );
  });

  it("every *FROM constant in either Worker's source is on it", () => {
    const list = new Set(allowlist());
    const senders = senderConstants();
    // Landmark: the scan really found the senders, so an empty result cannot pass.
    expect(senders.length).toBeGreaterThanOrEqual(6);
    const missing = senders.filter((s) => !list.has(s.address));
    expect(missing).toEqual([]);
  });
});
