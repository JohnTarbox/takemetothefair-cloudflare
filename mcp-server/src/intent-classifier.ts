/**
 * Smart intent classifier — runs in front of the address-based router in
 * the inbound-email entrypoint. See docs/inbound-email-intelligence.md
 * §C.1–C.3 for the full design.
 *
 * Why it lives in mcp-server (not the main app): the email entrypoint and
 * the InboundEmailWorkflow both live on the MCP worker. Keeping the
 * classifier here means one fewer cross-worker hop on the send path, and
 * the Workers AI binding is already provisioned on this worker for the
 * (existing) admin-side AI tools.
 *
 * Latency budget: ~500ms–2s typical. We race the AI call against a 2500ms
 * timeout; on timeout the entrypoint falls back to address-based routing
 * with routing_source='address_only' rather than bouncing the message.
 * See spec §"Risks + known fragility" for the cap rationale.
 */

import {
  CLASSIFIER_VERSION,
  DEFAULT_CONFIDENCE_THRESHOLD,
  SPAM_QUARANTINE_THRESHOLD,
  SYSTEM_PROMPT,
  buildUserPrompt,
} from "./intent-classifier-prompt";

/** 9-intent taxonomy + the unclear bucket. See spec §C.1. */
export type ClassifiedIntent =
  | "new_event"
  | "source_suggestion"
  | "correction"
  | "claim_request"
  | "vendor_inquiry"
  | "support"
  | "press"
  | "unsubscribe"
  | "spam"
  | "unclear";

/** Sub-intent for new_event only. NULL for everything else. */
export type ClassifiedSubIntent =
  | "single_url"
  | "multi_url"
  | "free_text"
  | "attachment_only"
  | "mixed"
  | null;

/** Trust tier as defined in drizzle/0075 (inbound_email_senders). */
export type SenderTrustTier = "unknown" | "trusted" | "watchlist" | "blocked";

/** One classification — either the only result (single-intent email) or
 *  one child of a multi-intent split. */
export type IntentClassification = {
  intent: ClassifiedIntent;
  subIntent: ClassifiedSubIntent;
  confidence: number;
  rationale: string;
  /** Reference clue extracted by the LLM. For source_suggestion/new_event
   *  this is the URL pointed at; for correction/claim_request this is a
   *  free-text identifier (event name + venue, etc.). NULL when not
   *  applicable. */
  refUrl?: string | null;
  refEventClue?: string | null;
};

/** Top-level classifier result. `intents` is always non-empty. When
 *  `intents.length >= 2` the entrypoint will split into N child rows
 *  (capped at 4 per spec §C.5). */
export type ClassifierResult = {
  intents: IntentClassification[];
  version: string;
  /** True iff this came back from the AI call rather than a fallback. */
  fromAi: boolean;
  /** When the model run started + ended. Used for telemetry. */
  startedAt: number;
  finishedAt: number;
};

export type ClassifierInput = {
  toAddress: string;
  fromAddress: string;
  senderTrustTier: SenderTrustTier;
  isReplyToOurThread: boolean;
  attachmentCount: number;
  attachmentTypes: string[];
  subject: string;
  bodyText: string;
};

// Bumped 2026-05-22 from 2500ms → 4000ms in conjunction with the
// model swap below — gave the smaller 3B model more headroom rather
// than tighter pressure, since the first 4 production runs already
// produced one timeout-fallback on the previous 2500ms gate.
const AI_TIMEOUT_MS = 4000;
// 2026-05-22 swap: was @cf/meta/llama-3.1-8b-instruct. The 8B model is
// overkill for a 9-class single-label intent classification — the same
// model is used for full event JSON extraction (which actually needs
// the larger context + structured-output reliability). The 3B variant
// is materially faster + cheaper at acceptable accuracy for this task.
// Bump CLASSIFIER_VERSION in intent-classifier-prompt.ts alongside any
// model change so the D.1 accuracy dashboard can attribute trends to
// the right model/prompt revision.
const MODEL = "@cf/meta/llama-3.2-3b-instruct";

/** Workers AI binding shape. We only call .run(); typed loosely so the
 *  caller can pass either the wrangler-injected `env.AI` binding or a
 *  test mock. */
export type AiBinding = {
  run: (
    model: string,
    input: {
      messages: { role: string; content: string }[];
      max_tokens?: number;
      temperature?: number;
    }
  ) => Promise<unknown>;
};

/**
 * Run the classifier. Always returns a result, even on AI failure —
 * caller checks `result.fromAi` to know whether to trust the confidence
 * (a fallback returns intent='unclear' with confidence 0).
 */
export async function classifyIntent(
  ai: AiBinding,
  input: ClassifierInput
): Promise<ClassifierResult> {
  const startedAt = Date.now();

  const userPrompt = buildUserPrompt(input);

  let aiResponseText: string;
  try {
    const raceResult = await Promise.race([
      ai.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("intent-classifier-timeout")), AI_TIMEOUT_MS)
      ),
    ]);
    aiResponseText =
      typeof raceResult === "string"
        ? raceResult
        : (raceResult as { response?: string }).response || "";
  } catch (err) {
    return {
      intents: [
        {
          intent: "unclear",
          subIntent: null,
          confidence: 0,
          rationale: `classifier-error: ${(err as Error).message}`,
          refUrl: null,
          refEventClue: null,
        },
      ],
      version: CLASSIFIER_VERSION,
      fromAi: false,
      startedAt,
      finishedAt: Date.now(),
    };
  }

  const parsed = parseClassifierResponse(aiResponseText);
  return {
    intents: parsed,
    version: CLASSIFIER_VERSION,
    fromAi: true,
    startedAt,
    finishedAt: Date.now(),
  };
}

/**
 * Parse the LLM's JSON output. Returns a single-element array for
 * single-intent responses, N elements for multi-intent responses.
 * Falls back to a single `unclear` entry if the JSON is malformed.
 *
 * Exported for unit tests.
 */
export function parseClassifierResponse(raw: string): IntentClassification[] {
  // Strip code fences and pull out the first JSON object/array. LLMs
  // sometimes leak `\`\`\`json` despite system-prompt instructions.
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:json)?\s*/i, "")
    .replace(/```[\s\S]*$/, "")
    .trim();

  const jsonStart = cleaned.search(/[{[]/);
  if (jsonStart < 0) {
    return [unclearFallback("classifier-no-json")];
  }
  const jsonText = cleaned.slice(jsonStart);

  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    // Try to find a balanced object end and re-parse — common when the
    // model trails with extra prose.
    const objEnd = findBalancedEnd(jsonText);
    if (objEnd > 0) {
      try {
        payload = JSON.parse(jsonText.slice(0, objEnd));
      } catch {
        return [unclearFallback("classifier-parse-failed")];
      }
    } else {
      return [unclearFallback("classifier-parse-failed")];
    }
  }

  // Multi-intent shape: {intents: [...]}
  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { intents?: unknown }).intents)
  ) {
    const children = (payload as { intents: unknown[] }).intents
      .map((child) => normalizeOne(child))
      .filter((c): c is IntentClassification => c !== null);
    if (children.length === 0) return [unclearFallback("classifier-empty-intents")];
    return children.slice(0, 4); // Spec §C.5: cap at 4
  }

  // Single-intent shape: bare object.
  const single = normalizeOne(payload);
  if (!single) return [unclearFallback("classifier-shape-mismatch")];
  return [single];
}

function unclearFallback(reason: string): IntentClassification {
  return {
    intent: "unclear",
    subIntent: null,
    confidence: 0,
    rationale: reason,
    refUrl: null,
    refEventClue: null,
  };
}

/**
 * Coerce a raw LLM-output object into our IntentClassification shape.
 * Returns null when the input is unrecognizable. Tolerant of common
 * shape drift (e.g. confidence as a string, missing rationale).
 */
function normalizeOne(raw: unknown): IntentClassification | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const intent = coerceIntent(r.intent);
  if (!intent) return null;

  const subIntent = coerceSubIntent(r.sub_intent);
  const confidence = coerceConfidence(r.confidence);
  const rationale = typeof r.rationale === "string" ? r.rationale.slice(0, 500) : "";
  const refUrl = typeof r.ref_url === "string" ? r.ref_url.slice(0, 2000) : null;
  const refEventClue = typeof r.ref_event_clue === "string" ? r.ref_event_clue.slice(0, 500) : null;

  return { intent, subIntent, confidence, rationale, refUrl, refEventClue };
}

const VALID_INTENTS: ClassifiedIntent[] = [
  "new_event",
  "source_suggestion",
  "correction",
  "claim_request",
  "vendor_inquiry",
  "support",
  "press",
  "unsubscribe",
  "spam",
  "unclear",
];

function coerceIntent(raw: unknown): ClassifiedIntent | null {
  if (typeof raw !== "string") return null;
  const norm = raw.toLowerCase().trim();
  return (VALID_INTENTS as string[]).includes(norm) ? (norm as ClassifiedIntent) : null;
}

const VALID_SUB_INTENTS = ["single_url", "multi_url", "free_text", "attachment_only", "mixed"];

function coerceSubIntent(raw: unknown): ClassifiedSubIntent {
  if (typeof raw !== "string") return null;
  const norm = raw.toLowerCase().trim();
  return (VALID_SUB_INTENTS as string[]).includes(norm) ? (norm as ClassifiedSubIntent) : null;
}

function coerceConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Find the index just past the matching close for the brace/bracket at
 * the start of `s`. Returns 0 if no balance found.
 */
function findBalancedEnd(s: string): number {
  const open = s[0];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return 0;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return 0;
}

// Re-export constants so callers don't import two files for one feature.
export { CLASSIFIER_VERSION, DEFAULT_CONFIDENCE_THRESHOLD, SPAM_QUARANTINE_THRESHOLD };
