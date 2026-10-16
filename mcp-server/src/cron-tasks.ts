/**
 * OPE-1374 — run a cron fan-out so that ONE task's failure cannot hide, skip,
 * or tear down the others.
 *
 * The cron branches used to be `ctx.waitUntil(Promise.all([...]))`. Promise.all
 * settles on the FIRST rejection, so the promise handed to `waitUntil` resolved
 * early while siblings were still in flight (the invocation may be torn down
 * under them), and the rejection itself was logged nowhere — the fan-out relied
 * on every task being failsoft by convention. A `.then()` chain had the same
 * flaw in sequence: a rejection in the first stage silently skipped the rest
 * (Monday's inventory notice behind the vendor-category watch).
 *
 * Tasks are THUNKS, not promises, so a task that throws synchronously while
 * starting is caught the same way as one that rejects later.
 */
import { logError } from "./logger.js";

export type CronTask = readonly [name: string, run: () => unknown];

export interface CronTaskOutcome {
  name: string;
  ok: boolean;
}

async function runOne(
  db: D1Database | null | undefined,
  cron: string,
  [name, run]: CronTask
): Promise<CronTaskOutcome> {
  try {
    await run();
    return { name, ok: true };
  } catch (error) {
    await logError(db, {
      source: `mcp:schedule:${name}`,
      message: `cron task '${name}' rejected (cron='${cron}')`,
      error,
      context: { cron, task: name },
    });
    return { name, ok: false };
  }
}

/**
 * Run every task concurrently and wait for ALL of them (allSettled semantics).
 * Each rejection is logged to error_logs under `mcp:schedule:<task name>`.
 * Never rejects.
 */
export async function settleCronTasks(
  db: D1Database | null | undefined,
  cron: string,
  tasks: readonly CronTask[]
): Promise<CronTaskOutcome[]> {
  const settled = await Promise.allSettled(tasks.map((t) => runOne(db, cron, t)));
  // runOne never rejects (logError never throws), but stay total anyway.
  return settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { name: tasks[i][0], ok: false }
  );
}

/**
 * Run tasks IN ORDER, each one regardless of whether the previous one failed —
 * for stages where a later task reads what an earlier one wrote, but must still
 * run when the earlier one breaks. Each rejection is logged by name.
 * Never rejects.
 */
export async function sequenceCronTasks(
  db: D1Database | null | undefined,
  cron: string,
  tasks: readonly CronTask[]
): Promise<CronTaskOutcome[]> {
  const out: CronTaskOutcome[] = [];
  for (const t of tasks) out.push(await runOne(db, cron, t));
  return out;
}
