/**
 * OPE-648 / OPE-795 — the fixed allowlist of boolean SEND gates, and their resolver.
 *
 * OPE-772 moved this out of the main app and into the shared constants package
 * WITHOUT changing its behaviour. The reason is the gate it could never report:
 * `OPERATOR_OUTBOUND_ENABLED` is enforced on the MCP Worker only, so the
 * main-app reader at /api/admin/capability-flags correctly answers
 * `readable_here: false, enabled: null` for it — the one gate an operator went
 * looking for was the one gate no exposed reader could speak for.
 *
 * The MCP Worker needs the identical allowlist and the identical resolver to
 * answer for itself. Re-declaring them there would make two definitions of
 * "what the send gates are", and the whole point of a fixed allowlist is that
 * there is one. So it lives here, and both Workers import it.
 *
 * ── The original OPE-648 rationale, unchanged ──
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

/**
 * OPE-862 — the human-confirmation token required for a REAL broadcast to a
 * full subscriber list.
 *
 * ## Why this is here and not local to one tool
 *
 * `send_newsletter_broadcast` shipped this gate (OPE-795) as a `const
 * CONFIRM_TOKEN = "GO"` local to its own file. `send_vendor_digest` reaches the
 * SAME vendor list and shipped with no equivalent — so a no-argument call
 * broadcast to every confirmed vendor subscriber, which is what happened at
 * 02:05Z on 2026-09-09.
 *
 * That is the identical failure the send-gate allowlist above exists to
 * prevent, one level up: when the definition of "an operator approved this"
 * lives inside one sender, the next sender does not inherit it, and nobody
 * notices until a send nobody authorised has already gone out. A second copy of
 * a send gate is how one of them stops being enforced.
 *
 * So the token is declared once, here, beside the gates it complements, and
 * every path that can reach a full list imports it. Adding a new broadcast
 * sender that does NOT import this is now a visible omission in review rather
 * than an invisible default.
 *
 * ## Why a token and not a boolean
 *
 * Same reasoning as `=== "true"` above. A boolean `confirmed: true` is
 * something an agent can produce by filling in a plausible-looking argument; an
 * opaque token it must be told is one it has to have been GIVEN. The value is
 * deliberately short enough for John to type in chat.
 */
export const BROADCAST_CONFIRM_TOKEN = "GO";
