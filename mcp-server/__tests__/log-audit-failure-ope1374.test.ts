/**
 * OPE-1374 — a lost audit row is logged with the action and target it described.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const logError = vi.fn(async () => {});
vi.mock("../src/logger.js", () => ({ logError: (...a: unknown[]) => logError(...(a as [])) }));

import { logAuditWriteFailure } from "../src/audit/log-audit-failure.js";
import { recordMutation } from "../src/audit/record-mutation.js";
import type { Db } from "../src/db.js";

beforeEach(() => logError.mockClear());

describe("logAuditWriteFailure (OPE-1374)", () => {
  it("writes an error_logs row naming the lost action and its target", async () => {
    const err = new Error("D1 busy");
    await logAuditWriteFailure({} as Db, {
      source: "mcp:tool:merge_vendor",
      action: "vendor.merge",
      targetType: "vendor",
      targetId: "v-keeper",
      error: err,
    });
    expect(logError).toHaveBeenCalledTimes(1);
    const opts = (logError.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts).toMatchObject({
      source: "mcp:tool:merge_vendor",
      error: err,
      context: { auditAction: "vendor.merge", targetType: "vendor", targetId: "v-keeper" },
    });
    expect(opts.message).toContain("vendor.merge");
  });
});

describe("recordMutation — insert failure is logged, not swallowed (OPE-1374)", () => {
  it("returns false AND logs when the audit insert throws", async () => {
    const db = {
      insert: () => ({
        values: async () => {
          throw new Error("insert failed");
        },
      }),
    } as unknown as Db;
    const ok = await recordMutation(db, {
      entityType: "venue",
      entityId: "venue-1",
      verb: "update",
      actor: "mcp:update_venue",
      before: { name: "Old" },
      after: { name: "New" },
    });
    expect(ok).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
    const opts = (logError.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts.context).toMatchObject({ targetType: "venue", targetId: "venue-1" });
  });
});
