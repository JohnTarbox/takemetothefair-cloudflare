/**
 * OPE-1403 — side-effect module: install Node's AsyncLocalStorage as a global.
 *
 * Next 16 resolves its request/work async storage at import time from
 * `globalThis.AsyncLocalStorage` and falls back to a fake that throws
 * "Invariant: AsyncLocalStorage accessed in runtime where it is not available"
 * when it is missing. Next's own server installs the global before loading
 * anything (next/dist/server/node-environment-baseline.js); a bare `tsx`
 * script that imports a Next module does not. Import this FIRST, before any
 * `next/*` import, in scripts that load Next server code outside Next.
 */
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
