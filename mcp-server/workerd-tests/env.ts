/**
 * OPE-907 — the bindings vitest.workerd.config.ts declares. Kept narrow on
 * purpose: only what the workerd tests bind, not the Worker's full `WorkerEnv`.
 */
import type { D1Migration } from "cloudflare:test";
import type { BurstCounter } from "../src/burst-counter.js";

export interface WorkerdTestEnv {
  DB: D1Database;
  BURST_COUNTER: DurableObjectNamespace<BurstCounter>;
  TEST_MIGRATIONS: D1Migration[];
}
