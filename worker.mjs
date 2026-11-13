// Main-app Worker entry (wrangler.toml `main`). OPE-1397 fix.
//
// OpenNext generates `.open-next/worker.js` at build time; this file wraps its
// default export so the anonymous-RSC-on-/admin sampler sees the RAW request.
// Next strips the RSC / Next-Router-State-Tree headers before middleware and
// before `headers()` in render — see src/worker/admin-rsc-sampler.ts for the
// file:line citations. Nothing else may be added here: every other concern
// belongs in Next (middleware / routes), where it is tested.
//
// `export *` re-exports OpenNext's Durable Object classes (DOQueueHandler is
// bound in wrangler.toml as NEXT_CACHE_DO_QUEUE — dropping it fails the deploy).
// Guarded by src/__tests__/worker-entry-ope1397.test.ts.
import openNextWorker from "./.open-next/worker.js";
import { withAdminRscSampler } from "./src/worker/admin-rsc-sampler";

export * from "./.open-next/worker.js";
export default withAdminRscSampler(openNextWorker);
