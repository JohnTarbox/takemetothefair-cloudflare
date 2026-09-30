/**
 * OPE-902 — both deploy artifacts verify passwords against the same
 * `users.password_hash`, so they must share ONE verifier. Their private copies
 * had drifted (the legacy branch was peppered in one Worker and not the other,
 * and the main app compared PBKDF2 digests with `===`). This pins the single
 * source so a second copy cannot quietly reappear.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES = ["src/lib/auth.ts", "mcp-server/src/oauth/utils.ts"];
const read = (f: string) => readFileSync(resolve(__dirname, "../../..", f), "utf8");

describe.each(FILES)("%s", (file) => {
  const src = read(file);

  it("delegates to the shared verifier (positive landmark)", () => {
    expect(src).toMatch(/verifyPasswordHash\(/);
    expect(src).toMatch(/from "@takemetothefair\/utils"/);
  });

  it("carries no password hashing of its own", () => {
    expect(src).not.toMatch(/deriveBits|crypto\.subtle\.digest|PBKDF2_ITERATIONS\s*=/);
  });
});
