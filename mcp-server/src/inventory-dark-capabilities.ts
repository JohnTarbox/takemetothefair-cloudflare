/**
 * OPE-1293 — the Monday inventory's "Dark capabilities" section.
 *
 * `darkCapabilityLines()` (OPE-368 R4) was documented "for the Monday
 * inventory" and had no caller: the inventory was built, formatted, and never
 * sent, so a silently-reverted flag — `CONDITIONAL_GET_PUBLIC_CACHE`, turned on
 * by John 2026-10-04, being the newest — paged no one.
 *
 * The flags live on two Workers. The main app's are read over
 * `GET /api/admin/capability-flags` (X-Internal-Key); the ones that route marks
 * `readable_here: false` belong to THIS Worker and are resolved from our own
 * env with the same shared rule (`isCapabilityFlagDark`).
 *
 * A reader that cannot read must never report a clean bill: a failed fetch, or
 * a flag neither Worker could resolve, renders as UNKNOWN — never "all lit".
 */
import { isCapabilityFlagDark } from "@takemetothefair/constants";
import { mainAppBindingRequest } from "./main-app-fetch.js";

export interface CapabilityFlagRow {
  name: string;
  worker: string;
  value: string | null;
  /** null = could not be resolved by anyone. */
  dark: boolean | null;
  off_is_deliberate: boolean;
  dark_means: string;
  readable_here: boolean;
}

export type CapabilityFlagsRead =
  | { ok: true; rows: CapabilityFlagRow[] }
  | { ok: false; reason: string };

/** Fill in the flags the main app could not see, from this Worker's env. */
export function resolveMcpOwnedFlags(
  rows: CapabilityFlagRow[],
  mcpEnv: Record<string, unknown>
): CapabilityFlagRow[] {
  return rows.map((r) => {
    if (r.readable_here) return r;
    const raw = mcpEnv[r.name];
    const value = typeof raw === "string" ? raw : null;
    return { ...r, value, dark: isCapabilityFlagDark(r.name, value) };
  });
}

/** The section's text. Always non-empty: an absent section is indistinguishable from a removed one. */
export function formatDarkCapabilitiesSection(read: CapabilityFlagsRead): string {
  if (!read.ok) {
    return (
      `\n\nDark capabilities: UNKNOWN — could not read the flag inventory (${read.reason}). ` +
      `This is NOT a clean bill; check /api/admin/capability-flags.`
    );
  }
  const n = read.rows.length;
  const unresolved = read.rows.filter((r) => r.dark === null);
  const dark = read.rows.filter((r) => r.dark === true);
  const line = (r: CapabilityFlagRow) =>
    ` • ${r.off_is_deliberate ? "" : "⚠️ "}${r.name} = ${r.value ?? "(unset)"} [${r.worker}]` +
    `${r.off_is_deliberate ? " (deliberate)" : " NOT deliberate"} — ${r.dark_means}`;
  // NOT-deliberate first: those are the ones that need a person.
  const ordered = [...dark].sort(
    (a, b) => Number(a.off_is_deliberate) - Number(b.off_is_deliberate)
  );

  let out = `\n\nDark capabilities (${n} flag${n === 1 ? "" : "s"} examined):`;
  if (dark.length === 0 && unresolved.length === 0) {
    out += `\n • All lit — ${n} of ${n} on.`;
  } else {
    out += ordered.map((r) => `\n${line(r)}`).join("");
  }
  if (unresolved.length > 0) {
    out +=
      `\n • UNKNOWN (${unresolved.length}): ` +
      unresolved.map((r) => `${r.name} [${r.worker}]`).join(", ");
  }
  return out;
}

interface FlagsEnv {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export async function readCapabilityFlags(
  env: FlagsEnv & Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<CapabilityFlagsRead> {
  const url = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/admin/capability-flags`;
  const init: RequestInit = { headers: { "X-Internal-Key": env.INTERNAL_API_KEY ?? "" } };
  try {
    const res = env.MAIN_APP
      ? await env.MAIN_APP.fetch(mainAppBindingRequest(url, init))
      : await fetchImpl(url, init);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { flags?: unknown };
    if (!Array.isArray(body.flags)) return { ok: false, reason: "no flags array in response" };
    return { ok: true, rows: resolveMcpOwnedFlags(body.flags as CapabilityFlagRow[], env) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
