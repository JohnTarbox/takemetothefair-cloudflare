/**
 * OPE-1374 — a cron fan-out must not let one task's failure hide, skip, or
 * tear down the others.
 *
 * Before: `ctx.waitUntil(Promise.all([...]))` settled on the first rejection
 * (siblings still in flight; the rejection logged nowhere), and
 * `runScheduledVendorCategoryWatch().then(() => runWeeklyInventoryNotice())`
 * skipped Monday's inventory whenever the watch rejected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const logError = vi.fn(async () => {});
vi.mock("../src/logger.js", () => ({ logError: (...a: unknown[]) => logError(...(a as [])) }));

import { sequenceCronTasks, settleCronTasks } from "../src/cron-tasks.js";

const DB = {} as D1Database;
const CRON = "0 6 * * *";

beforeEach(() => logError.mockClear());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("settleCronTasks (OPE-1374)", () => {
  it("one task rejects, another throws synchronously: the slow siblings still COMPLETE and each failure is logged by name", async () => {
    const done: string[] = [];
    const out = await settleCronTasks(DB, CRON, [
      ["fast-ok", async () => void done.push("fast-ok")],
      ["rejects", async () => Promise.reject(new Error("boom"))],
      [
        "throws-sync",
        () => {
          throw new Error("sync boom");
        },
      ],
      [
        "slow-ok",
        async () => {
          await sleep(30);
          done.push("slow-ok");
        },
      ],
    ]);

    // The returned promise did not settle until the SLOW sibling finished —
    // Promise.all would have resolved/rejected at "rejects".
    expect(done.sort()).toEqual(["fast-ok", "slow-ok"]);
    expect(out).toEqual([
      { name: "fast-ok", ok: true },
      { name: "rejects", ok: false },
      { name: "throws-sync", ok: false },
      { name: "slow-ok", ok: true },
    ]);

    expect(logError).toHaveBeenCalledTimes(2);
    const calls = logError.mock.calls.map((c) => (c as unknown[])[1] as Record<string, unknown>);
    const byTask = Object.fromEntries(calls.map((o) => [(o.context as { task: string }).task, o]));
    expect(Object.keys(byTask).sort()).toEqual(["rejects", "throws-sync"]);
    expect(byTask.rejects.source).toBe("mcp:schedule:rejects");
    expect(byTask.rejects.message).toContain("'rejects'");
    expect((byTask.rejects.error as Error).message).toBe("boom");
    expect(byTask.rejects.context).toEqual({ cron: CRON, task: "rejects" });
    expect((byTask["throws-sync"].error as Error).message).toBe("sync boom");
  });

  it("never rejects even when every task fails", async () => {
    await expect(
      settleCronTasks(DB, CRON, [
        ["a", () => Promise.reject(new Error("a"))],
        ["b", () => Promise.reject(new Error("b"))],
      ])
    ).resolves.toHaveLength(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });
});

describe("sequenceCronTasks (OPE-1374)", () => {
  it("a rejection in the first stage does NOT skip the next stage, and is logged by name", async () => {
    const order: string[] = [];
    const out = await sequenceCronTasks(DB, CRON, [
      [
        "vendor-category-watch",
        async () => {
          order.push("watch");
          throw new Error("watch failed");
        },
      ],
      ["weekly-inventory-notice", async () => void order.push("inventory")],
    ]);
    expect(order).toEqual(["watch", "inventory"]);
    expect(out.map((o) => o.ok)).toEqual([false, true]);
    expect(logError).toHaveBeenCalledTimes(1);
    const opts = (logError.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts.source).toBe("mcp:schedule:vendor-category-watch");
  });

  it("runs stages strictly in order (stage 2 starts only after stage 1 settles)", async () => {
    const order: string[] = [];
    await sequenceCronTasks(DB, CRON, [
      [
        "first",
        async () => {
          await sleep(20);
          order.push("first");
        },
      ],
      ["second", async () => void order.push("second")],
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("scheduled() wiring (OPE-1374, structural)", () => {
  const SRC = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
    "utf8"
  );
  const start = SRC.indexOf("async scheduled(controller: ScheduledController");
  const end = SRC.indexOf("async fetch(request: Request", start);
  const body = SRC.slice(start, end);

  it("locates the scheduled() handler (guards against a vacuous pass)", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("settleCronTasks(");
  });

  it("no cron branch fans out with Promise.all", () => {
    expect(body).not.toMatch(/Promise\.all\(/);
  });

  it("the weekly inventory notice is not chained behind the category watch", () => {
    expect(body).not.toMatch(/\.then\(\s*\(\)\s*=>\s*runWeeklyInventoryNotice/);
    expect(body).toMatch(/\["weekly-inventory-notice", \(\) => runWeeklyInventoryNotice\(env\)\]/);
  });

  it("every settled task has a unique name (a name is the only handle a logged rejection carries)", () => {
    const names = [...body.matchAll(/\[\s*"([a-z0-9:+-]+)",\s*\(\)\s*=>/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(30);
    expect(new Set(names).size).toBe(names.length);
  });
});
