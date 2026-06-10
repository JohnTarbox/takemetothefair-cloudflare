import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Spike config — defaults only (no incremental cache backend yet). The real
// migration will wire an ISR/cache backend (R2 or KV) here for the ~40
// `export const revalidate` pages. For a feasibility build this is enough.
export default defineCloudflareConfig();
