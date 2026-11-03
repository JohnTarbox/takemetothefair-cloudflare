/**
 * OPE-1374 — email verification's claim auto-approval must not fail silently.
 *
 * Before: one `catch { // swallow }` wrapped both passes, logged nothing, and a
 * throw in email-match skipped domain-match. The token is consumed by then and
 * nothing retries, so the claim sat PENDING with no trace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const approveEmail = vi.fn();
const approveDomain = vi.fn();
const rescore = vi.fn();
const logError = vi.fn();

vi.mock("@/lib/claims/resolve-claim-at-signup", () => ({
  approvePendingEmailMatchClaims: (...a: unknown[]) => approveEmail(...a),
}));
vi.mock("@/lib/claims/resolve-claim-in-wizard", () => ({
  approvePendingDomainMatchClaims: (...a: unknown[]) => approveDomain(...a),
}));
vi.mock("@/lib/claims/claim-evidence", () => ({
  rescoreEvidenceAfterVerification: (...a: unknown[]) => rescore(...a),
}));
vi.mock("@/lib/logger", () => ({
  logError: (...a: unknown[]) => logError(...a),
}));

import {
  validateAndConsumeVerificationToken,
  VERIFY_TOKEN_LOG_SOURCE,
} from "@/lib/email/verify-token";

const EMAIL = "owner@example.com";

/** Minimal stand-in for the Drizzle surface the function touches. */
function fakeDb(opts: { userRow?: { id: string } | null; selectThrows?: boolean } = {}) {
  const userRow = opts.userRow === undefined ? { id: "user-1" } : opts.userRow;
  const updates: unknown[] = [];
  const deletes: number[] = [];
  const db = {
    query: {
      verificationTokens: {
        findFirst: vi.fn(async () => ({
          identifier: EMAIL,
          token: "tok",
          expires: new Date(Date.now() + 60_000),
        })),
      },
    },
    update: () => ({
      set: (v: unknown) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        deletes.push(1);
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (opts.selectThrows) throw new Error("D1 select blew up");
            return userRow ? [userRow] : [];
          },
        }),
      }),
    }),
  };
  return {
    db: db as unknown as Parameters<typeof validateAndConsumeVerificationToken>[0],
    updates,
    deletes,
  };
}

beforeEach(() => {
  approveEmail.mockReset();
  approveDomain.mockReset();
  rescore.mockReset();
  logError.mockReset();
  rescore.mockResolvedValue(undefined);
});

describe("validateAndConsumeVerificationToken — claim auto-approval (OPE-1374)", () => {
  it("success: both passes run, their claims are merged, nothing is logged", async () => {
    approveEmail.mockResolvedValue({
      approvedClaims: [{ entityType: "VENDOR", entitySlug: "acme" }],
    });
    approveDomain.mockResolvedValue({
      approvedClaims: [{ entityType: "PROMOTER", entitySlug: "acme-events" }],
    });
    const { db, updates, deletes } = fakeDb();

    const res = await validateAndConsumeVerificationToken(db, "tok");

    expect(res).toEqual({
      ok: true,
      email: EMAIL,
      approvedClaims: [
        { entityType: "VENDOR", entitySlug: "acme" },
        { entityType: "PROMOTER", entitySlug: "acme-events" },
      ],
    });
    expect(approveEmail).toHaveBeenCalledWith(db, "user-1", EMAIL);
    expect(approveDomain).toHaveBeenCalledWith(db, "user-1", EMAIL);
    expect(updates).toHaveLength(1);
    expect(deletes).toHaveLength(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("email-match throws: domain-match STILL runs, its claims are returned, and the failure is logged with context", async () => {
    approveEmail.mockRejectedValue(new Error("email-match exploded"));
    approveDomain.mockResolvedValue({
      approvedClaims: [{ entityType: "VENUE", entitySlug: "the-grange" }],
    });
    const { db } = fakeDb();

    const res = await validateAndConsumeVerificationToken(db, "tok");

    // Verification itself still succeeds.
    expect(res.ok).toBe(true);
    expect(approveDomain).toHaveBeenCalledWith(db, "user-1", EMAIL);
    if (res.ok) {
      expect(res.approvedClaims).toEqual([{ entityType: "VENUE", entitySlug: "the-grange" }]);
    }

    expect(logError).toHaveBeenCalledTimes(1);
    const [, opts] = logError.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.source).toBe(VERIFY_TOKEN_LOG_SOURCE);
    expect(opts.message).toMatch(/email-match/);
    expect((opts.error as Error).message).toBe("email-match exploded");
    expect(opts.context).toEqual({ stage: "email-match", userId: "user-1" });
  });

  it("domain-match throws: email-match claims are kept and the failure is logged", async () => {
    approveEmail.mockResolvedValue({
      approvedClaims: [{ entityType: "VENDOR", entitySlug: "acme" }],
    });
    approveDomain.mockRejectedValue(new Error("domain-match exploded"));
    const { db } = fakeDb();

    const res = await validateAndConsumeVerificationToken(db, "tok");

    expect(res.ok && res.approvedClaims).toEqual([{ entityType: "VENDOR", entitySlug: "acme" }]);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, opts] = logError.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.context).toEqual({ stage: "domain-match", userId: "user-1" });
  });

  it("user lookup throws: verification succeeds, approval is skipped, and the failure is logged", async () => {
    const { db } = fakeDb({ selectThrows: true });

    const res = await validateAndConsumeVerificationToken(db, "tok");

    expect(res).toEqual({ ok: true, email: EMAIL, approvedClaims: [] });
    expect(approveEmail).not.toHaveBeenCalled();
    expect(approveDomain).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    const [, opts] = logError.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.context).toEqual({ stage: "user-lookup", userId: null });
  });

  it("evidence re-score throws: logged as a warn, verification still ok", async () => {
    approveEmail.mockResolvedValue({ approvedClaims: [] });
    approveDomain.mockResolvedValue({ approvedClaims: [] });
    rescore.mockRejectedValue(new Error("rescore exploded"));
    const { db } = fakeDb();

    const res = await validateAndConsumeVerificationToken(db, "tok");

    expect(res.ok).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, opts] = logError.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.level).toBe("warn");
    expect(opts.context).toEqual({ stage: "rescore-evidence", userId: "user-1" });
  });
});
