export const dynamic = "force-dynamic";
/**
 * OPE-509 — answer "is the newsletter armed?" by READING it.
 *
 * Before this, the only way to establish a send gate's live value was to query
 * a third-party subscriber's `email_send_ledger` rows and reason backwards
 * about which sends the gate would have 409'd. That inference happened to be
 * correct on 2026-08-20, but it also sent John to perform a flag flip that was
 * already a no-op — and an inference that is usually right is exactly the kind
 * of thing that is confidently wrong once.
 *
 * The `CAPABILITY_FLAGS` inventory and resolver already existed (OPE-368 R4)
 * and were unit-tested — but nothing in production imported them. A reporter
 * with no reader reports nothing. This is that reader.
 *
 * ── Why this cannot just resolve every flag ─────────────────────────────────
 * The flags live on TWO separate Workers with separate configs. This route runs
 * in the main app, so `env.PHOTO_VISION_ENABLED` is simply absent here — and
 * `resolveCapabilityFlags` would score an absent flag as DARK. Reporting the
 * MCP's live capabilities as dark because we cannot see them would be worse
 * than reporting nothing, so flags owned by the MCP Worker are returned with
 * `readable_here: false` and a null value, never as `dark`.
 */

import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  CAPABILITY_FLAGS,
  resolveCapabilityFlags,
  resolveSendGates,
} from "@/lib/analytics-overview/dark-capabilities";

function runtimeEnv(): Record<string, string | undefined> {
  try {
    return getCloudflareEnv() as unknown as Record<string, string | undefined>;
  } catch {
    // Off-CF (local `next build`, tests): process.env is the equivalent source.
    return process.env as Record<string, string | undefined>;
  }
}

export const GET = withAuthorized(async () => {
  const env = runtimeEnv();

  const mainAppFlags = CAPABILITY_FLAGS.filter((f) => f.worker === "main-app");
  const mcpFlags = CAPABILITY_FLAGS.filter((f) => f.worker !== "main-app");

  const resolved = resolveCapabilityFlags(env, mainAppFlags).map((s) => ({
    name: s.name,
    worker: s.worker,
    value: s.value,
    dark: s.dark,
    off_is_deliberate: s.offIsDeliberate,
    dark_means: s.darkMeans,
    readable_here: true,
  }));

  const notReadable = mcpFlags.map((f) => ({
    name: f.name,
    worker: f.worker,
    value: null,
    // NOT `dark`. This worker cannot see the MCP's env, and "absent" here means
    // "not configured on this Worker", not "off".
    dark: null,
    off_is_deliberate: f.offIsDeliberate,
    dark_means: f.darkMeans,
    readable_here: false,
  }));

  return NextResponse.json({
    ok: true,
    // The single question this endpoint exists to answer, hoisted so it can be
    // read without parsing the list.
    newsletter_send_enabled: env.NEWSLETTER_SEND_ENABLED ?? null,
    // OPE-648 — every allowlisted SEND gate, resolved, so an agent can CHECK a
    // gate before sending instead of learning its value from a refusal. Takes no
    // key parameter: there is nothing to pass and therefore nothing to abuse.
    // A gate this Worker does not enforce reports enabled:null, never false.
    send_gates: resolveSendGates(env, "main-app"),
    worker: "meetmeatthefair-app",
    storage: "plaintext [vars] in wrangler.toml — the committed file is the source of truth",
    note:
      "Plaintext vars are REPLACED wholesale by `wrangler deploy` from the committed " +
      "wrangler.toml; a dashboard edit survives only until the next CI deploy. To change a " +
      "gate, edit wrangler.toml and deploy. Flags marked readable_here:false live on the " +
      "meetmeatthefair-mcp Worker and must be read there.",
    flags: [...resolved, ...notReadable],
  });
});
