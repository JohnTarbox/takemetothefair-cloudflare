import { isCapabilityFlagDark } from "@takemetothefair/constants";
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
 *
 * ── …but completeness IS checked (OPE-1394) ─────────────────────────────────
 * Hand-curated drifted: by 2026-10 this listed 8 flags while the code read 15
 * `*_ENABLED` vars. `__tests__/capability-inventory-complete-ope1394.test.ts`
 * now scans both Workers for flag-like names and fails on any that is in
 * neither CAPABILITY_FLAGS nor NON_CAPABILITY_FLAGS (below, each with a
 * reason). The human still writes the sentence; CI makes sure one is written.
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
    // OPE-1394 — was `true` ("the ack copy has not been approved"), stale since
    // John approved the copy and the flag went ON 2026-08-28 (#1089). Off now
    // would be a regression, not a decision.
    offIsDeliberate: false,
  },
  {
    name: "VENDOR_DIGEST_SEND_ENABLED",
    worker: "main-app",
    darkMeans: "The Monday vendor digest composes but does not reach vendors.",
    offIsDeliberate: false,
  },
  {
    // OPE-332 — ON since 2026-10-04 (John: "turn it on"). Listed so a silent
    // revert (a dashboard override, or a commit) reads as dark on the live
    // inventory instead of going unnoticed: the code keeps emitting validators
    // either way, so nothing else would look different.
    name: "CONDITIONAL_GET_PUBLIC_CACHE",
    worker: "main-app",
    darkMeans:
      "Anonymous public detail pages are sent `no-store`, so crawlers re-download every " +
      "unchanged page in full and the 304 (Not Modified) path never fires.",
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
  // ── OPE-1394 — flags that were read in code but missing from this list ──
  {
    name: "AUTO_REPLY_ENABLED",
    worker: "mcp",
    // Default-OPEN: only the exact string "false" holds the acks (email-gates.ts).
    darkMeans:
      "Inbound senders get no automated acknowledgment; their mail is still stored and " +
      "triaged, but nobody tells them it arrived (OPE-626).",
    offIsDeliberate: false,
  },
  {
    name: "OPERATOR_OUTBOUND_ENABLED",
    worker: "mcp",
    darkMeans:
      "Operator-composed emails approved via review_operator_draft are never delivered (OPE-596).",
    offIsDeliberate: false,
  },
  {
    name: "PROMOTER_OUTREACH_ENABLED",
    worker: "mcp",
    darkMeans:
      "Approved promoter-outreach emails are refused; nothing reaches promoters (OPE-384).",
    offIsDeliberate: false,
  },
  {
    name: "UNROUTED_ASK_ENABLED",
    worker: "mcp",
    darkMeans:
      "A sender whose mail matches no event is never asked which event they meant; the " +
      "mail is stored and forwarded to admin only. Off by OPE-6 ruling until John approves.",
    offIsDeliberate: true,
  },
  {
    name: "SPAM_EVENT_RECOVERY_ENABLED",
    worker: "mcp",
    darkMeans:
      "A real event submission the classifier marked as spam terminates silently instead " +
      "of reaching admin triage, so the submitter's event never appears (OPE-803).",
    offIsDeliberate: false,
  },
  {
    name: "FAQ_PILOT_EVENT_SLUGS",
    worker: "main-app",
    // List-valued: dark when it names no slug (isCapabilityFlagDark).
    darkMeans:
      "No event page renders the FAQ section or its FAQPage JSON-LD — the Phase A pilot " +
      "allow-list is empty. Choosing pilot events is John's call.",
    offIsDeliberate: true,
  },
  {
    name: "EMIT_PERFORMER_SUBEVENTS",
    worker: "main-app",
    darkMeans:
      "Event-page JSON-LD does not list billed performers as schema.org subEvents (OPE-114); " +
      "performers still render on the page itself.",
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

/**
 * OPE-1394 — flag-like names the completeness check finds that are deliberately
 * NOT capabilities: operator-only commit gates and internal data toggles that
 * withhold nothing from a real person. Each needs a reason; an entry whose flag
 * is no longer read anywhere fails the check too, so this list cannot rot.
 */
export const NON_CAPABILITY_FLAGS: Record<string, string> = {
  REPLAY_COMMIT_ENABLED:
    "Operator-only commit gate for the replay_inbound_attachment MCP tool (OPE-469); " +
    "off is the normal state between deliberate replays.",
  EH3_P1_BACKFILL_ENABLED:
    "Operator-only commit gate for the one-shot event-series backfill (EH3); internal data.",
  GOODWILL_FLIP_ENABLED:
    "Internal data-resolution toggle (shadow vs write for source-reliability flips); " +
    "nothing customer-facing is withheld while off.",
};

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
    // OPE-1293 — the rule now lives in @takemetothefair/constants so the MCP
    // Worker's Monday inventory resolves its own flags with the same code.
    const dark = isCapabilityFlagDark(flag.name, value);
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

// OPE-772 — the send-gate allowlist + resolver moved to @takemetothefair/constants
// so the MCP Worker can answer for the gates it alone enforces. Re-exported here
// because this module's existing consumers (the capability-flags route, its
// tests) import them from this path, and a move that also changes every import
// site makes the diff about the wrong thing.
export {
  SEND_GATE_NAMES,
  resolveSendGates,
  type SendGateName,
  type SendGateState,
} from "@takemetothefair/constants";
