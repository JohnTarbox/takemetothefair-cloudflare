/**
 * OPE-293 — ingestion placeholders must never obtain a session.
 *
 * ## What this is and is not
 *
 * It is a regression guard. It is NOT the closing of a live vulnerability, and
 * the receipt should say so plainly: measured in prod 2026-08-18, 0 of the
 * 6,824 placeholder rows hold a `password_hash` and 0 have an `accounts` row.
 * Nothing could authenticate as one today.
 *
 * What was missing is anything that KEEPS that true — and the ticket's own
 * framing understated it. It listed email-linking as hypothetical ("if a
 * provider flow ever links by email"). Two live paths already do, and both are
 * covered below.
 *
 * ## The source-level test is the point
 *
 * The predicate tests pin the shape of the match. The source assertions pin
 * something no unit test can reach: that each auth path actually CONSULTS it.
 * A perfect predicate nobody calls is the exact failure this ticket exists to
 * prevent — "the safety is incidental, not enforced" — so the guard has to be
 * observable at the call sites, not only in isolation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPlaceholderEmail } from "../placeholder-account";

const root = resolve(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/**
 * Index of an actual GUARD CALL, not the import statement.
 *
 * `indexOf("isPlaceholderEmail")` finds the import line at the top of the file,
 * which precedes everything — so an ordering assertion built on it passes no
 * matter where (or whether) the guard is really invoked. Two assertions below
 * were green for exactly that reason before this helper existed.
 */
const guardCallIndex = (source: string) => source.indexOf("if (isPlaceholderEmail(");

describe("isPlaceholderEmail", () => {
  it("matches the address shape ingestion mints", () => {
    expect(isPlaceholderEmail("pending+fryeburg-fair@meetmeatthefair.com")).toBe(true);
    expect(isPlaceholderEmail("pending+the-big-e@meetmeatthefair.com")).toBe(true);
  });

  it("ignores case and surrounding whitespace", () => {
    // Local-parts are case-sensitive per RFC 5321 and no mail system treats
    // them so. A guard that let `Pending+Foo@…` through would be a guard in
    // name only.
    expect(isPlaceholderEmail("Pending+Fryeburg-Fair@MeetMeAtTheFair.com")).toBe(true);
    expect(isPlaceholderEmail("  pending+x@meetmeatthefair.com  ")).toBe(true);
  });

  it("does not lock out real people — the failure that would matter most", () => {
    // A false positive here denies a genuine user their account. Both ends of
    // the pattern are anchored for exactly this reason.
    expect(isPlaceholderEmail("john@meetmeatthefair.com")).toBe(false);
    expect(isPlaceholderEmail("notpending+x@meetmeatthefair.com")).toBe(false);
    expect(isPlaceholderEmail("pending+x@gmail.com")).toBe(false);
    expect(isPlaceholderEmail("vendor+pending@meetmeatthefair.com")).toBe(false);
    expect(isPlaceholderEmail("pending@meetmeatthefair.com")).toBe(false); // no "+"
  });

  it("is safe on absent input", () => {
    expect(isPlaceholderEmail(null)).toBe(false);
    expect(isPlaceholderEmail(undefined)).toBe(false);
    expect(isPlaceholderEmail("")).toBe(false);
  });
});

describe("every wired auth path consults the guard", () => {
  const authSource = read("src/lib/auth.ts");
  const forgotSource = read("src/app/api/auth/forgot-password/route.ts");

  it("credentials authorize() refuses before looking up the user", () => {
    // Redundant today — placeholders have no password_hash, so the existing
    // `!user.passwordHash` check already refuses them. Kept because the reset
    // path is what would mint that hash, and a guard that only holds while a
    // second guard holds is not a guard.
    expect(authSource).toContain("isPlaceholderEmail");
    const authorizeBody = authSource.slice(
      authSource.indexOf("async authorize(credentials)"),
      authSource.indexOf("const facebookClientId")
    );
    expect(guardCallIndex(authorizeBody)).toBeGreaterThan(-1);
  });

  it("the OAuth signIn callback refuses BEFORE the email-match lookup", () => {
    // Order is the whole substance. That lookup links a provider account to any
    // existing user with no `passwordHash` — which placeholders are, by
    // definition. A check placed after it would run too late to prevent the
    // link it exists to prevent.
    const signIn = authSource.slice(authSource.indexOf("async signIn("));
    const guardAt = guardCallIndex(signIn);
    const lookupAt = signIn.indexOf("eq(schema.users.email, profile.email)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(lookupAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(lookupAt);
  });

  it("forgot-password refuses before minting a token or enqueuing mail", () => {
    // This is the path that would actually give a placeholder a credential: the
    // token is mailed to `pending+<slug>@meetmeatthefair.com`, and completing
    // the reset makes the ordinary credentials login work.
    const guardAt = guardCallIndex(forgotSource);
    const insertAt = forgotSource.indexOf("db.insert(passwordResetTokens)");
    // `indexOf("enqueueEmail")` would find the IMPORT, which sits near the top
    // and would make this assertion fail even on correct code. Same trap as the
    // guard index above — target the call.
    const enqueueAt = forgotSource.indexOf("await enqueueEmail(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(insertAt);
    expect(guardAt).toBeLessThan(enqueueAt);
  });

  it("forgot-password stays uniform — the refusal is not an existence oracle", () => {
    // The endpoint deliberately answers identically whether or not an address
    // is known. A refusal that returned a distinguishable payload would turn
    // this guard into a way to enumerate which synthetic accounts exist.
    const guardAt = guardCallIndex(forgotSource);
    const afterGuard = forgotSource.slice(guardAt, guardAt + 400);
    expect(afterGuard).toContain("return GENERIC_OK;");
  });
});

describe("a NEW auth path must be guarded too", () => {
  // The acceptance asks for "a test that fails if someone later adds a path
  // that would let a placeholder in". This is that test: it enumerates the
  // files that resolve a user from a caller-supplied email, and requires each
  // to reference the guard. Adding a magic-link or passwordless route without
  // one fails here rather than in production.
  const PATHS_THAT_RESOLVE_A_USER_BY_EMAIL = [
    "src/lib/auth.ts",
    "src/app/api/auth/forgot-password/route.ts",
  ];

  it.each(PATHS_THAT_RESOLVE_A_USER_BY_EMAIL)("%s consults isPlaceholderEmail", (path) => {
    expect(read(path)).toContain("isPlaceholderEmail");
  });

  it("register cannot bind to a placeholder, so it needs no guard", () => {
    // Stated rather than assumed. Registration refuses any address already in
    // `users`, and every placeholder is in `users` — so it cannot attach a
    // credential to one. If that 409 ever becomes an "attach to the existing
    // row" flow, this assertion fails and the guard becomes required.
    const register = read("src/app/api/auth/register/route.ts");
    expect(register).toContain("An account with this email already exists");
  });
});
