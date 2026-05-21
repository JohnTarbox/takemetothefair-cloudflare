/**
 * Intent classifier prompt — taxonomy + few-shots for the LLM that runs in
 * front of the inbound-email address router. The prompt is intentionally
 * verbose because every additional intent class needs both a definition
 * and an example for the LLM to confidently distinguish edges (e.g.
 * source_suggestion vs new_event vs claim_request).
 *
 * Versioning: bump CLASSIFIER_VERSION when changing this file so the
 * accuracy dashboard can attribute regressions/improvements to the right
 * prompt revision. See spec §C.3.
 */

/** Bumped any time the prompt OR the model binding changes. Stored on
 *  every classified inbound_emails row in classifier_version.
 *
 *  v1 (2026-05-20): @cf/meta/llama-3.1-8b-instruct, 2500ms timeout.
 *  v2 (2026-05-22): @cf/meta/llama-3.2-3b-instruct, 4000ms timeout.
 *    Smaller/faster model on a single-label classification task fits
 *    the workload better — 8B was overkill, and the tight 2500ms
 *    timeout already produced one `intent-classifier-timeout` fallback
 *    in the first 4 production classifications. The 3B model with a
 *    4s budget gives both more compute headroom and tighter median
 *    latency. Prompt itself unchanged from v1. */
export const CLASSIFIER_VERSION = "c-2026-05-22-v2";

/** Default confidence gate. Below this, we fall back to address-based
 *  routing and flag the row for admin review. Tuned per Q1 in spec —
 *  calibrate against the first 100 production classifications. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

/** Spam quarantine threshold (Q6). Higher than the routing threshold
 *  because false positives drop the message silently. */
export const SPAM_QUARANTINE_THRESHOLD = 0.9;

export const SYSTEM_PROMPT = `You are an intent classifier for the inbound email pipeline of meetmeatthefair.com, a New England event discovery website. Your job is to read an email and decide which workflow it belongs in.

You always respond with valid JSON only, no explanations outside the JSON. The JSON either describes a single intent OR an array of intents when the email contains multiple distinct requests.`;

export const INTENT_TAXONOMY_DOC = `INTENT TAXONOMY (pick exactly one per message, or split into multiple per the multi-intent rule):

- new_event:          Sender is submitting a NEW event to be added to the site.
                      Examples: a URL to an event page; a flyer attachment;
                      "Here's my craft fair this weekend"; a prose
                      description of an event with name + date + venue.
- source_suggestion:  Sender is pointing us at a WEBSITE/feed as a potential
                      source of events to harvest, NOT a single event.
                      Examples: "I discovered a site listing events at X";
                      "Have you tried looking at this calendar?";
                      "You should check this website".
- correction:         Sender claims something on an existing meetmeatthefair
                      event listing is wrong (date, venue, name, etc.) or
                      that a published event is incorrect/cancelled.
                      Examples: a meetmeatthefair.com/events/ URL in the body;
                      "the date is wrong"; "appears to be incorrect";
                      a reply to one of our approval-notification emails.
- claim_request:      Sender is claiming ownership/representation of an
                      event listing (organizer or promoter).
                      Examples: "I am the organizer of this event";
                      "How do I claim my listing?"; "I run this fair".
- vendor_inquiry:     A vendor/exhibitor asking about how to be listed,
                      how to apply to events, or about their vendor profile.
                      Examples: "How do I list my booth?";
                      "I exhibit at fairs and would like to be added";
                      "How do I sign up to vend?".
- support:            General how-to / help / can-you-help questions that
                      don't fit the other buckets.
                      Examples: "How does your site work?";
                      "Can you help me find an event in Maine?".
- press:              Media inquiry, partnership pitch, podcast invite,
                      writer asking for a quote.
                      Examples: "Writing for The Boston Globe...";
                      "We'd like to feature MMATF on our podcast".
- unsubscribe:        Opt-out request (newsletter or otherwise).
                      Examples: "Stop emailing me"; "Remove from your list";
                      "unsubscribe".
- spam:               Obvious junk — phishing, pharma keywords, off-topic
                      promotional, mass-marketed BCC lists, gambling, etc.
                      No New England event context.
- unclear:            Genuinely ambiguous OR you're below the confidence
                      threshold. Use sparingly — admin will route manually.

SUB-INTENT (for new_event ONLY — null for other intents):

- single_url:       Exactly one event URL in body, no attachments.
- multi_url:        Two or more distinct event URLs in body.
- free_text:        No URLs, prose description with event details.
- attachment_only:  No URLs, no descriptive prose, only PDF/JPG attachment.
- mixed:            URLs PLUS free-text supplementary details.

CONFIDENCE: 0.0 to 1.0. Use ≥0.85 when the signal is strong and unambiguous.
            Use 0.6–0.85 for plausible but mixed signals. Use <0.6 only when
            the email is genuinely confusing — that triggers admin fallback.

MULTI-INTENT RULE: If the email contains 2+ DISTINCT requests (e.g. a source
suggestion + a new-event URL + a correction in one message), return an
"intents" array with one object per child intent. Cap at 4 entries — if the
email has 5+ intents, return only your top 4 by confidence. The pipeline
will flag the rest for admin.

For each multi-intent child, include any reference clue that identifies
which target the intent points at (ref_url for source_suggestion / new_event,
ref_event_clue for correction / claim_request).`;

/**
 * Build the user prompt with the email's headers + body. Body capped at
 * 3000 chars per spec §C.3 — longer is rarely informative and burns tokens.
 */
export function buildUserPrompt(input: {
  toAddress: string;
  fromAddress: string;
  senderTrustTier: string;
  isReplyToOurThread: boolean;
  attachmentCount: number;
  attachmentTypes: string[];
  subject: string;
  bodyText: string;
}): string {
  const body = (input.bodyText || "").slice(0, 3000);
  const attTypes = input.attachmentTypes.length ? input.attachmentTypes.join(", ") : "(none)";

  return `Classify this inbound email.

${INTENT_TAXONOMY_DOC}

---
RESPONSE FORMAT (return ONE of these two shapes):

Single-intent (most emails):
{
  "intent": "new_event",
  "sub_intent": "single_url",
  "confidence": 0.94,
  "rationale": "one sentence explaining the classification"
}

Multi-intent (when the email has 2+ distinct requests):
{
  "intents": [
    {
      "intent": "source_suggestion",
      "ref_url": "https://example.com/events/",
      "confidence": 0.92,
      "rationale": "..."
    },
    {
      "intent": "new_event",
      "sub_intent": "single_url",
      "ref_url": "https://facebook.com/...",
      "confidence": 0.88,
      "rationale": "..."
    }
  ]
}

---
EMAIL CONTEXT:
to_address: ${input.toAddress}
from_address: ${input.fromAddress}
sender_trust_tier: ${input.senderTrustTier}
is_reply_to_our_thread: ${input.isReplyToOurThread}
attachment_count: ${input.attachmentCount}
attachment_types: ${attTypes}
subject: ${input.subject || "(no subject)"}
body (first 3000 chars):
${body}

JSON response:`;
}
