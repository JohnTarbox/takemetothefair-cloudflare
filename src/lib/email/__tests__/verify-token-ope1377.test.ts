/**
 * OPE-1377 — validateAndConsumeVerificationToken (src/lib/email/verify-token.ts).
 *
 * A verification token is the proof of inbox control that unlocks rung-1/2
 * claim approval, so it must be single-use and must expire. Negative: unknown,
 * expired, and already-used tokens never verify the user. Positive: a live
 * token verifies the matching user exactly once and is deleted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";

const approveEmail = vi.fn(async () => ({ approvedClaims: [] }));
const approveDomain = vi.fn(async () => ({ approvedClaims: [] }));
vi.mock("@/lib/claims/resolve-claim-at-signup", () => ({
  approvePendingEmailMatchClaims: (...a: unknown[]) => approveEmail(...(a as [])),
}));
vi.mock("@/lib/claims/resolve-claim-in-wizard", () => ({
  approvePendingDomainMatchClaims: (...a: unknown[]) => approveDomain(...(a as [])),
}));
vi.mock("@/lib/claims/claim-evidence", () => ({
  rescoreEvidenceAfterVerification: vi.fn(async () => undefined),
}));

import { validateAndConsumeVerificationToken } from "../verify-token";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;
let db: Parameters<typeof validateAndConsumeVerificationToken>[0];

const nowSec = () => Math.floor(Date.now() / 1000);
const verifiedAt = () =>
  (
    raw.prepare("SELECT email_verified AS v FROM users WHERE id = 'u1'").get() as {
      v: number | null;
    }
  ).v;
const tokenCount = () =>
  (raw.prepare("SELECT COUNT(*) AS n FROM verification_tokens").get() as { n: number }).n;
const addToken = (token: string, expiresSec: number) =>
  raw
    .prepare("INSERT INTO verification_tokens (identifier, token, expires) VALUES (?, ?, ?)")
    .run("u1@x.com", token, expiresSec);

beforeEach(() => {
  approveEmail.mockClear();
  approveDomain.mockClear();
  raw = new Database(":memory:");
  raw.exec(ddlFor(schema.users));
  raw.exec(ddlFor(schema.verificationTokens));
  raw.prepare("INSERT INTO users (id, email, email_verified) VALUES ('u1','u1@x.com', NULL)").run();
  db = drizzle(raw, { schema }) as unknown as typeof db;
});

describe("validateAndConsumeVerificationToken (OPE-1377)", () => {
  it("unknown token → not_found; the user stays unverified", async () => {
    const res = await validateAndConsumeVerificationToken(db, "no-such-token");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(verifiedAt()).toBeNull();
    expect(approveEmail).not.toHaveBeenCalled();
  });

  it("expired token → expired, is deleted, and does NOT verify the user", async () => {
    addToken("tok-expired", nowSec() - 60);
    const res = await validateAndConsumeVerificationToken(db, "tok-expired");
    expect(res).toEqual({ ok: false, reason: "expired" });
    expect(verifiedAt()).toBeNull();
    expect(tokenCount()).toBe(0);
    expect(approveEmail).not.toHaveBeenCalled();
  });

  it("a live token verifies the user once; replaying it is not_found", async () => {
    addToken("tok-live", nowSec() + 3600);
    const first = await validateAndConsumeVerificationToken(db, "tok-live");
    expect(first).toEqual({ ok: true, email: "u1@x.com", approvedClaims: [] });
    expect(verifiedAt()).not.toBeNull();
    expect(tokenCount()).toBe(0);
    expect(approveEmail).toHaveBeenCalledWith(expect.anything(), "u1", "u1@x.com");

    const replay = await validateAndConsumeVerificationToken(db, "tok-live");
    expect(replay).toEqual({ ok: false, reason: "not_found" });
  });
});
