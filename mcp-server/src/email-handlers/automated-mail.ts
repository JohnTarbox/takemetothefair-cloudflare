/**
 * OPE-1148 — never auto-reply to machine mail, and never let it create events.
 *
 * The specimen: on 2026-09-23 someone confirmed a Gmail forwarding request that
 * had arrived at submit@, and John's whole inbox flowed in for 2½ hours. The
 * classifier called Google Calendar reminders `new_event` at 0.90 and an FSF
 * newsletter 0.94, so 12 acknowledgements went to calendar-notification@,
 * facebookmail, list.moveon.org and friends, and 6 junk PENDING events were
 * created. Classifier confidence is the wrong gate for "should we reply": a
 * machine sender is a fact about the MESSAGE, readable from its headers,
 * whatever the body looks like.
 *
 * `detectAutomatedMail` returns a verdict the email handler acts on BEFORE the
 * classifier or the workflow runs, so a held message gets no ack of any kind
 * (reply:* and email:submission-received are both workflow sends) and creates
 * no event. The row is still stored — held, with its reason — so it can be
 * salvaged if a verdict was ever wrong.
 *
 * Measured before choosing the rules (prod, 2026-09-24): 117 inbound emails
 * have ever produced an APPROVED event; 0 of them came from a bulk-mail
 * return-path/host, a no-reply/notification sender, facebookmail, or an
 * auto-forwarding host. List-Id / List-Unsubscribe / Auto-Submitted were never
 * stored, so their false-positive rate is NOT measured — `automationHeaders`
 * on SenderSignals captures them from now on so it can be.
 */

export type AutomatedKind = "forwarding-confirmation" | "auto-forwarded" | "automated";

export interface AutomatedVerdict {
  kind: AutomatedKind;
  /** Short, stable, greppable — stored as the held row's reason. */
  reason: string;
}

type HeaderBag = { get(name: string): string | null } | undefined | null;

/**
 * Mail that asks us to CONFIRM a forward. Confirming it is what piped a whole
 * inbox into submit@; it must reach a human as an alert, never be relayed.
 */
export const FORWARDING_CONFIRMATION_SENDERS: readonly string[] = ["forwarding-noreply@google.com"];

/** Exact addresses that only ever send notifications. */
export const NOTIFICATION_SENDER_ADDRESSES: readonly string[] = [
  "calendar-notification@google.com",
];

/**
 * Domains that relay notifications on behalf of a platform. A real organizer
 * never writes to us FROM these — a Facebook group post arriving as
 * groupupdates@facebookmail.com is a notification about a post, not a person.
 * Subdomains match too (`e.linkedin.com`).
 */
export const NOTIFICATION_RELAY_DOMAINS: readonly string[] = [
  "facebookmail.com",
  "mail.instagram.com",
  "linkedin.com",
  "groups.io",
  "academia-mail.com",
];

/**
 * Local-part TOKENS that mark a robot. Matched as whole dash/dot/underscore/plus
 * delimited tokens, so `calendar-notification`, `sc-noreply` and
 * `updates-noreply` match but a person at `noreplyfan@` or `notifyme@` does not
 * — the same token rule `forwarded-machine-notification.ts` uses.
 */
export const ROBOT_LOCAL_TOKENS: readonly string[] = [
  "noreply",
  "donotreply",
  "notification",
  "notifications",
];
// NOT "bounce"/"bounces": this is a fair directory, and bounce-house rental
// vendors write from `bounce.house@` / `bounce-rentals@`. Real bounces come
// from mailer-daemon/postmaster, which ROBOT_LOCAL_PARTS already holds.

/** Whole local parts that are robots (multi-token names the token rule would split). */
export const ROBOT_LOCAL_PARTS: readonly string[] = [
  "no-reply",
  "do-not-reply",
  "do_not_reply",
  "mailer-daemon",
  "postmaster",
  "notify",
];

/** Gmail's forwarding servers — every auto-forwarded message on 09-23 came from one. */
const AUTO_FORWARD_HOST_SUFFIX = ".unverified-forwarding.1e100.net";

function splitAddress(addr: string): { local: string; domain: string } {
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at < 0 ? { local: a, domain: "" } : { local: a.slice(0, at), domain: a.slice(at + 1) };
}

function onDomain(domain: string, list: readonly string[]): string | null {
  return list.find((d) => domain === d || domain.endsWith(`.${d}`)) ?? null;
}

export function detectAutomatedMail(input: {
  headers: HeaderBag;
  fromAddr: string;
  /** SenderSignals.sendingHost — the origin-most `Received: from` host. */
  sendingHost?: string | null;
}): AutomatedVerdict | null {
  const from = input.fromAddr.trim().toLowerCase();
  const { local, domain } = splitAddress(from);
  const h = (name: string) => (input.headers?.get(name) ?? "").trim();

  // 1. A forwarding request. Checked first: it is also a no-reply sender, and
  //    a plain "automated" hold would lose the alert.
  if (FORWARDING_CONFIRMATION_SENDERS.includes(from)) {
    return { kind: "forwarding-confirmation", reason: `forwarding-confirmation:${from}` };
  }

  // 2. An auto-forwarded mailbox. Gmail stamps X-Forwarded-For/-To and sends
  //    from its forwarding pool. A person forwarding by hand ("Fwd:") sends
  //    from their own address with neither, so manual forwards are untouched.
  const fwdFor = h("X-Forwarded-For") || h("X-Forwarded-To");
  if (fwdFor) return { kind: "auto-forwarded", reason: `auto-forwarded:x-forwarded-for` };
  const host = (input.sendingHost ?? "").toLowerCase();
  if (host.endsWith(AUTO_FORWARD_HOST_SUFFIX)) {
    return { kind: "auto-forwarded", reason: `auto-forwarded:gmail-forwarding-host` };
  }

  // 3. RFC 3834 and list headers — the sender telling us it is a machine.
  const autoSubmitted = h("Auto-Submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { kind: "automated", reason: `header:auto-submitted=${autoSubmitted.slice(0, 40)}` };
  }
  const precedence = h("Precedence").toLowerCase();
  if (["bulk", "list", "junk", "auto_reply"].includes(precedence)) {
    return { kind: "automated", reason: `header:precedence=${precedence}` };
  }
  if (h("List-Id")) return { kind: "automated", reason: "header:list-id" };
  if (h("List-Unsubscribe")) return { kind: "automated", reason: "header:list-unsubscribe" };

  // 4. The sender address itself.
  if (NOTIFICATION_SENDER_ADDRESSES.includes(from)) {
    return { kind: "automated", reason: `sender:${from}` };
  }
  const relay = onDomain(domain, NOTIFICATION_RELAY_DOMAINS);
  if (relay) return { kind: "automated", reason: `relay-domain:${relay}` };
  if (ROBOT_LOCAL_PARTS.includes(local))
    return { kind: "automated", reason: `robot-local:${local}` };
  const token = local.split(/[.\-_+]/).find((t) => ROBOT_LOCAL_TOKENS.includes(t));
  if (token) return { kind: "automated", reason: `robot-local-token:${token}` };

  return null;
}

/**
 * The headers `detectAutomatedMail` reads, captured on EVERY inbound row (via
 * SenderSignals) so the rules' false-positive rate can be measured later — the
 * measurement this ticket could not make because none of them were stored.
 * JSON, only the headers that are present; null when none are.
 */
export function automationHeadersJson(headers: HeaderBag): string | null {
  const keys = [
    "Auto-Submitted",
    "Precedence",
    "List-Id",
    "List-Unsubscribe",
    "X-Forwarded-For",
    "X-Forwarded-To",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = (headers?.get(k) ?? "").trim();
    if (v) out[k] = v.slice(0, 300);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// ── burst breaker ─────────────────────────────────────────────────────────────

export interface BurstThresholds {
  windowMinutes: number;
  maxMessages: number;
  maxSenders: number;
}

/**
 * Defaults, used only if the `tunable_thresholds` rows are missing. Measured
 * 2026-09-24: in 120 days submit@ never saw more than 2 distinct senders in an
 * hour (117 hours at 1, one at 2); the 09-23 incident hour had 6. Tripping
 * above 4 senders AND 6 messages in 60 minutes is twice the observed peak and
 * still below the incident.
 */
export const DEFAULT_BURST_THRESHOLDS: BurstThresholds = {
  windowMinutes: 60,
  maxMessages: 6,
  maxSenders: 4,
};

export const BURST_THRESHOLD_KEYS = {
  windowMinutes: "inbound_burst_window_minutes",
  maxMessages: "inbound_burst_max_messages",
  maxSenders: "inbound_burst_max_senders",
} as const;

/**
 * Tripped when the window (INCLUDING the message being decided) holds more
 * messages than maxMessages AND more distinct senders than maxSenders. Both,
 * so one person sending twelve forwards in an hour — John's normal busy hour —
 * never trips it.
 */
export function burstTripped(
  counts: { messages: number; senders: number },
  t: BurstThresholds
): boolean {
  return counts.messages > t.maxMessages && counts.senders > t.maxSenders;
}

/**
 * The single message that TRIPS the breaker raises the alert; the rest of the
 * burst is held quietly. Without this, a 200-message flood would send 200
 * alerts — the same failure mode as the flood.
 *
 * "Trips" = tripped with this message counted, not tripped without it. Keyed on
 * the transition, not on `senders === max + 1`: that equality stays true for
 * every later message from a sender already in the window, and would alert on
 * each of them.
 */
export function isBurstCrossing(
  counts: { messages: number; senders: number },
  senderIsNewInWindow: boolean,
  t: BurstThresholds
): boolean {
  const before = {
    messages: counts.messages - 1,
    senders: counts.senders - (senderIsNewInWindow ? 1 : 0),
  };
  return burstTripped(counts, t) && !burstTripped(before, t);
}

/**
 * OPE-1148 item 6 — a message the classifier called `unclear` with NO
 * confidence at all gets no acknowledgement. The specimen: premium@academia-mail
 * ("Someone cited this name") was classified unclear at 0 and still received
 * `reply:unfetchable-url`, because submit@ routes by ADDRESS and the ack is
 * chosen by the handler, not the classifier.
 *
 * Only an explicit `unclear` at <= 0 — a NULL intent (the classifier never ran,
 * e.g. address-routed mail it was not asked about) is not evidence of anything
 * and keeps its ack.
 */
export function isZeroConfidenceUnclear(
  classifiedIntent: string | null | undefined,
  classifiedConfidence: number | null | undefined
): boolean {
  return classifiedIntent === "unclear" && !(Number(classifiedConfidence ?? 0) > 0);
}
