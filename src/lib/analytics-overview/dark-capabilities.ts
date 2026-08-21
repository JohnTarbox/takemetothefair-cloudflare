/**
 * OPE-368 (R4) item 4 — report which customer-facing capabilities are dark.
 *
 * ── The pattern this exists for ─────────────────────────────────────────────
 * Twice now a customer-facing capability has shipped behind a flag, the flag
 * was never flipped, and nothing anywhere reported that the capability was
 * dark:
 *
 *   NEWSLETTER_SEND_ENABLED   off until John said "go fully live" 2026-08-05
 *   EMAIL_REPLY_ENABLED       off since it shipped; discovered 2026-08-10 only
 *                             because a human happened to be in the loop when
 *                             an agent was refused
 *
 * A feature flag gating a built capability is itself a queue: something must
 * notice when one has been off since the day it landed. Nothing did, so the
 * only detector was coincidence.
 *
 * ── Why the flag list is hard-coded ─────────────────────────────────────────
 * Deliberately an explicit inventory rather than "every env var ending in
 * _ENABLED". A capability that matters should be named by a human, with a
 * sentence about what is dark while it is off — the sentence is the whole
 * value. An automatic scrape would report a truthful list nobody could act on,
 * and would silently miss any flag that breaks the naming convention, which is
 * the same class of blindness this is meant to end.
 */

export interface CapabilityFlag {
  name: string;
  /** Which artifact's env holds it — they are configured separately. */
  worker: "main-app" | "mcp";
  /** What is NOT happening while this is off. Written for an operator. */
  darkMeans: string;
  /** True when "false"/unset is the SAFE state and off is not itself a defect. */
  offIsDeliberate: boolean;
}

/**
 * The customer-facing flags. Anything that can withhold something from a real
 * person belongs here; purely internal toggles do not.
 */
export const CAPABILITY_FLAGS: CapabilityFlag[] = [
  {
    name: "EMAIL_REPLY_ENABLED",
    worker: "mcp",
    darkMeans:
      "Free-form replies to inbound senders are refused. Customers who write in get an " +
      "auto-ack promising a reply, and the reply itself cannot be sent. Refused drafts " +
      "queue in pending_email_replies (OPE-368).",
    offIsDeliberate: true,
  },
  {
    name: "NEWSLETTER_SEND_ENABLED",
    worker: "main-app",
    darkMeans: "Composed newsletter issues are never delivered to subscribers.",
    offIsDeliberate: false,
  },
  {
    // OPE-509 — missing from this inventory until the 2026-08-20 gate audit,
    // despite being exactly the shape this file exists for: a capability that
    // withholds something from a real person. Its absence is the same blindness
    // the header warns about, one level up — the inventory itself needs
    // auditing, not just the flags in it.
    name: "SUBMISSION_ACK_ENABLED",
    worker: "main-app",
    darkMeans:
      "Someone who submits an event at /suggest-event gets no acknowledgment. The page " +
      "promises a reply in 24-48h and nothing sends (OPE-412).",
    // Deliberate: the ack copy has not been approved for send yet.
    offIsDeliberate: true,
  },
  {
    name: "VENDOR_DIGEST_SEND_ENABLED",
    worker: "main-app",
    darkMeans: "The Monday vendor digest composes but does not reach vendors.",
    offIsDeliberate: false,
  },
  {
    name: "PHOTO_VISION_ENABLED",
    worker: "mcp",
    darkMeans:
      "Submitted photos are not classified, so poster/booth routing falls back to manual triage.",
    offIsDeliberate: true,
  },
  {
    name: "PHOTO_AUTOWRITE_ENABLED",
    worker: "mcp",
    darkMeans: "Classified photos are never attached to an event without a human step.",
    offIsDeliberate: true,
  },
  {
    name: "ENRICHMENT_DRY_RUN",
    worker: "mcp",
    // Inverted sense: "true" means dry-run, i.e. the capability is dark.
    darkMeans:
      "INVERTED FLAG — 'true' means dry-run: enrichment proposals are computed but never " +
      "written. Reads as healthy while nothing is applied.",
    offIsDeliberate: true,
  },
];

export interface CapabilityFlagState extends CapabilityFlag {
  value: string | null;
  /** True when the capability is currently withholding something. */
  dark: boolean;
}

/**
 * Resolve each flag against a supplied env map.
 *
 * `ENRICHMENT_DRY_RUN` is inverted — "true" means the capability is OFF — and
 * is handled explicitly rather than by a clever rule, because a clever rule is
 * how the next inverted flag gets read backwards and reported as healthy.
 */
export function resolveCapabilityFlags(
  env: Record<string, string | undefined>,
  flags: CapabilityFlag[] = CAPABILITY_FLAGS
): CapabilityFlagState[] {
  return flags.map((flag) => {
    const value = env[flag.name] ?? null;
    // ENRICHMENT_DRY_RUN mirrors the production rule EXACTLY —
    // `env.ENRICHMENT_DRY_RUN !== "false"` in enrichment/select-candidates.ts
    // and promoter-select.ts. So UNSET means dry-run is ON, i.e. dark.
    //
    // My first cut wrote `value === "true"` here, which reported an unset flag
    // as lit — announcing "enrichment is writing" while nothing was. A test
    // caught it. The lesson is not "be careful with inverted flags": it is that
    // a reporter must re-derive the consumer's own rule rather than restate it
    // from memory, which is the OPE-372 defect wearing a smaller hat.
    const dark = flag.name === "ENRICHMENT_DRY_RUN" ? value !== "false" : value !== "true";
    return { ...flag, value, dark };
  });
}

/** One line per dark capability, for the Monday inventory. Empty when all lit. */
export function darkCapabilityLines(states: CapabilityFlagState[]): string[] {
  return states
    .filter((s) => s.dark)
    .map(
      (s) =>
        `${s.name} = ${s.value ?? "(unset)"} [${s.worker}]${s.offIsDeliberate ? " (deliberate)" : " ⚠️ NOT deliberate"} — ${s.darkMeans}`
    );
}
