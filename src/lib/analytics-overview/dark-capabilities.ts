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

/**
 * OPE-648 — the fixed allowlist of boolean SEND gates, and their resolver.
 *
 * ## Why an allowlist and not a `get_env(key)`
 *
 * The need is "an agent must be able to CHECK a send gate before sending,
 * instead of discovering its value by sending" — the rule that
 * `vendor-inquiry-response` states in bold and that was, until this shipped,
 * impossible to follow: `workers_get_worker` returns name and id only, and no
 * tool reported gate state, so the only available check was the prohibited one.
 *
 * A generic key-value reader would answer that need and also be a
 * credential-exfiltration tool wearing a diagnostic hat. This takes **no key
 * parameter at all** — there is nothing to pass and therefore nothing to abuse.
 * Adding a gate here is a code change that goes through review.
 *
 * ## Why the value is compared to exactly "true"
 *
 * Every consumer does `=== "true"`. A truthiness test would read the STRING
 * "false" as on, which is the most expensive possible way to misread a kill
 * switch (OPE-596 pins the same property on its own gate).
 */
export const SEND_GATE_NAMES = [
  "EMAIL_REPLY_ENABLED",
  "OPERATOR_OUTBOUND_ENABLED",
  "NEWSLETTER_SEND_ENABLED",
  "VENDOR_DIGEST_SEND_ENABLED",
] as const;

export type SendGateName = (typeof SEND_GATE_NAMES)[number];

/**
 * Which Worker(s) actually enforce each gate.
 *
 * `EMAIL_REPLY_ENABLED` is on BOTH — the main app refuses to enqueue and the
 * MCP consumer refuses to send — which is why a reader on one Worker can report
 * its own copy but must not claim to speak for the other. The two are
 * configured separately and CAN disagree; a reply composed on one and refused
 * by the other is precisely what that looks like.
 */
const SEND_GATE_WORKERS: Record<SendGateName, ReadonlyArray<"main-app" | "mcp">> = {
  EMAIL_REPLY_ENABLED: ["main-app", "mcp"],
  OPERATOR_OUTBOUND_ENABLED: ["mcp"],
  NEWSLETTER_SEND_ENABLED: ["main-app"],
  VENDOR_DIGEST_SEND_ENABLED: ["main-app"],
};

export interface SendGateState {
  name: SendGateName;
  /** Raw value as configured, or null when unset on THIS Worker. */
  value: string | null;
  /** Exactly `value === "true"`. Null when this Worker cannot read it. */
  enabled: boolean | null;
  /** False when the gate lives only on another Worker — then `enabled` is null. */
  readable_here: boolean;
  enforced_on: ReadonlyArray<"main-app" | "mcp">;
}

/**
 * Resolve every allowlisted send gate from `env`, as seen by `worker`.
 *
 * A gate this Worker does not enforce reports `enabled: null`, never `false`.
 * "Absent from my env" and "off" are different claims, and conflating them is
 * how a reader becomes worse than no reader at all.
 */
export function resolveSendGates(
  env: Record<string, string | undefined>,
  worker: "main-app" | "mcp"
): SendGateState[] {
  return SEND_GATE_NAMES.map((name) => {
    const enforcedOn = SEND_GATE_WORKERS[name];
    const readableHere = enforcedOn.includes(worker);
    const value = readableHere ? (env[name] ?? null) : null;
    return {
      name,
      value,
      enabled: readableHere ? value === "true" : null,
      readable_here: readableHere,
      enforced_on: enforcedOn,
    };
  });
}
