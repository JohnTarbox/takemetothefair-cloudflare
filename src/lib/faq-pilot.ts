// Phase A FAQ pilot gate — comma-separated event slugs from
// FAQ_PILOT_EVENT_SLUGS env var. Per MMATF-FAQ-Strategy.md §9 Phase A,
// this rolls FAQ rendering to a hand-curated set (e.g. top-50 by GSC
// impressions) so we can A/B-compare before full rollout.
//
// Empty / unset env var = no events in the pilot. Whitespace and case are
// normalized so the env value is forgiving of formatting drift.

import { getCloudflareContext } from "@opennextjs/cloudflare";

function readPilotEnv(): string {
  try {
    const { env } = getCloudflareContext();
    return (env as { FAQ_PILOT_EVENT_SLUGS?: string }).FAQ_PILOT_EVENT_SLUGS ?? "";
  } catch {
    return process.env.FAQ_PILOT_EVENT_SLUGS ?? "";
  }
}

export function parsePilotSlugList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

export function isFaqPilotEvent(slug: string): boolean {
  if (!slug) return false;
  const set = parsePilotSlugList(readPilotEnv());
  return set.has(slug.trim().toLowerCase());
}
