/**
 * OPE-204 — vision identification of a booth photo.
 *
 * Given the bytes of one on-site photo, decide whether it shows a VENDOR BOOTH
 * (and if so, who) or is a GENERAL fair scene. The vendor name comes from
 * legible signage — banners, table signs, product displays.
 *
 * ── Why a real vision model and not OCR ───────────────────────────────────
 * The repo already has an image path (`env.AI.toMarkdown`, OPE-68) but it is
 * managed image→markdown OCR: you cannot ask it a question. OCR is also
 * structurally unable to do the one thing this feature must get right —
 * rejecting *"a banner glimpsed behind another booth"* (the ticket's own named
 * false positive). OCR reads all text in the frame with no notion of which
 * booth is the subject, so it would happily attribute a neighbour's banner to
 * the photo. A vision model can be asked "whose booth is the SUBJECT of this
 * photo?" and can decline. Hence a new `AI.run` rail (John's call, 2026-07-15).
 *
 * ⚠️ OPERATIONAL PREREQUISITE: `@cf/meta/llama-3.2-11b-vision-instruct`
 * requires a ONE-TIME per-account Meta license acceptance before it will serve.
 * Until that is done every call fails. Run once per Cloudflare account:
 *
 *   curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct \
 *     -X POST -H "Authorization: Bearer $TOKEN" -d '{"prompt":"agree"}'
 *
 * ── Never invent ──────────────────────────────────────────────────────────
 * The prompt forbids guessing a URL/phone/city that isn't legibly on the sign.
 * A hallucinated website on a public vendor record is worse than a missing one:
 * it is a factual claim about a real business we'd be publishing.
 */

/**
 * Vision model. Kept as a constant (not inlined) so it is swappable in one
 * place, mirroring WORKERS_AI_MODEL's role for the text model. NOT the same
 * model as the text lane — that one (llama-3.3-70b) has no image input.
 */
export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/** Cap the model's output — we want a small JSON object, not an essay. */
const MAX_TOKENS = 384;

export type BoothKind = "booth" | "general" | "unclear";

export interface BoothIdentification {
  /** booth = a vendor's stall is the subject; general = fair scenery. */
  kind: BoothKind;
  /** Business name EXACTLY as it appears on signage, or null. */
  businessName: string | null;
  /** Only when legibly printed on the sign. Never inferred from the name. */
  website: string | null;
  /** What they sell, if evident. Free-form short tokens. */
  products: string[];
  /** Model's self-reported confidence, clamped 0..1. */
  confidence: number;
  /** Short reason — surfaced to the operator when staging for review. */
  rationale: string;
  /**
   * OPE-403 follow-up — WHICH failure produced an UNIDENTIFIED result.
   *
   * `UNIDENTIFIED` was returned from five different places (the `ai.run` catch,
   * empty text, no JSON braces, a JSON parse error, a non-object) and all five
   * emitted the identical rationale string. On the first live photo after
   * enabling vision the lane logged "vision model returned nothing usable" and
   * we could not tell whether the model had errored, replied in an unexpected
   * shape, or replied with prose — three problems with three different fixes.
   *
   * That is the same defect this ticket is about (a fail-soft path discarding
   * its reason), one layer down. Undefined on a successful parse.
   */
  failureReason?: string;
}

/** A total failure to identify. Callers stage/skip rather than write. */
export const UNIDENTIFIED: BoothIdentification = {
  kind: "unclear",
  businessName: null,
  website: null,
  products: [],
  confidence: 0,
  rationale: "vision model returned nothing usable",
};

/**
 * UNIDENTIFIED, but saying which of the five paths got us here. Truncated
 * because this lands in a log line and an admin_actions payload, not a report.
 */
export function unidentified(failureReason: string): BoothIdentification {
  // 500, not 200: at 200 a retried reason (two causes plus the quoted reply)
  // was itself being cut, so the log could not be distinguished from the very
  // truncation it was reporting. A diagnostic that clips its own evidence at
  // the interesting point is worse than no diagnostic.
  return { ...UNIDENTIFIED, failureReason: failureReason.slice(0, 500) };
}

/** A compact description of an unexpected reply, for the failure reason.
 *  Never the full body — a vision reply can be hundreds of tokens of prose. */
export function describeRawShape(raw: unknown): string {
  if (raw === null) return "null";
  if (typeof raw === "string") return `string(${raw.length})`;
  if (typeof raw !== "object") return typeof raw;
  const keys = Object.keys(raw as object)
    .slice(0, 6)
    .join(",");
  const resp = (raw as { response?: unknown }).response;
  return `object{${keys}} response=${resp === undefined ? "absent" : typeof resp}`;
}

export const VISION_PROMPT = `You are looking at ONE photograph taken at a public agricultural fair or craft show.

Decide what the photo IS, then report only what you can actually READ or SEE.

Rules — follow exactly:
1. If a vendor's booth/stall/tent is the MAIN SUBJECT, kind = "booth".
2. If it is general fair scenery (rides, crowds, animals, buildings, food court
   with no single subject booth), kind = "general".
3. If you cannot tell, kind = "unclear".
4. business_name: copy the business name EXACTLY as printed on the booth's own
   banner, table sign, or awning. If the only legible sign belongs to a
   DIFFERENT booth in the background, do NOT use it — that is not this booth.
   If no name is legible, use null.
5. website: ONLY if a web address is legibly printed. Never guess one from the
   business name. Otherwise null.
6. products: short lowercase words for what they sell, ONLY if visible.
7. confidence: 0.0-1.0. Use a LOW value (<0.5) if the sign is partly obscured,
   blurry, at an angle, or if more than one booth competes to be the subject.
8. NEVER invent a name, URL, phone number, or town. Missing is correct;
   inventing is a factual error we would publish.

Reply with ONLY a JSON object, no prose, no markdown fence:
{"kind":"booth|general|unclear","business_name":string|null,"website":string|null,"products":[string],"confidence":number,"rationale":string}`;

/** Minimal shape of the Workers AI binding we need. */
export interface VisionAi {
  run(
    model: string,
    input: { image: number[]; prompt: string; max_tokens?: number }
  ): Promise<unknown>;
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(1, v));
}

function cleanString(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "none") return null;
  return s.slice(0, max);
}

/**
 * Map an already-parsed reply object onto a BoothIdentification.
 *
 * Shared by BOTH entry shapes — the object Workers AI hands back directly, and
 * the object we dig out of a string reply. Deliberately one implementation: two
 * copies of this mapping could disagree about the `general` → drop-the-name
 * rule, which is the rule that stops scenery carrying a vendor into a write.
 */
function fromParsedObject(obj: Record<string, unknown>): BoothIdentification {
  const rawKind = typeof obj.kind === "string" ? obj.kind.toLowerCase().trim() : "";
  const kind: BoothKind =
    rawKind === "booth" ? "booth" : rawKind === "general" ? "general" : "unclear";

  const products = Array.isArray(obj.products)
    ? obj.products
        .map((p) => cleanString(p, 60))
        .filter((p): p is string => p !== null)
        .slice(0, 12)
    : [];

  const website = cleanString(obj.website, 300);

  return {
    kind,
    // A "general" photo has no business — drop any name the model volunteered
    // so a scenery shot can never carry a vendor into the write path.
    businessName: kind === "booth" ? cleanString(obj.business_name) : null,
    website: kind === "booth" ? website : null,
    products: kind === "booth" ? products : [],
    confidence: clamp01(obj.confidence),
    rationale: cleanString(obj.rationale, 300) ?? "",
  };
}

/**
 * Parse the model's reply into a BoothIdentification.
 *
 * Pure + total — exported so the parsing contract is unit-testable without an
 * AI binding, and so a garbage reply degrades to UNIDENTIFIED (→ staged for
 * review) instead of throwing inside the inbound workflow.
 */
export function parseVisionReply(raw: unknown): BoothIdentification {
  // Workers AI response shape varies by model: some return a string, some
  // { response: string }, and a non-string `.response` once crashed the email
  // entrypoint outright (OPE-189). Coerce defensively, exactly as
  // intent-classifier.ts does.
  const respField = (raw as { response?: unknown })?.response;

  // ── Workers AI returns an ALREADY-PARSED object for this model ────────────
  //
  // Measured against prod 2026-08-16, not assumed:
  //   result keys            → ['response','tool_calls','usage']
  //   typeof result.response → 'object'
  //   result.response        → {"kind":"booth","business_name":"Petal & Pearl",…}
  //
  // The platform parses JSON replies for us now. This function predates that
  // and accepted ONLY a string `.response`, so a perfectly good identification
  // fell through to text="" and was reported as "the model returned nothing
  // usable" — twice, on real photos, before the failure reasons added in this
  // ticket made the shape visible.
  //
  // Note the trap in the older comment below: OPE-189 hardened against a
  // non-string `.response` CRASHING us. It never considered that a non-string
  // `.response` might be the actual answer. Defending against a shape is not
  // the same as understanding it.
  //
  // Arrays are excluded deliberately — `typeof [] === "object"`, and a JSON
  // array is not the object contract this parser reads.
  if (respField && typeof respField === "object" && !Array.isArray(respField)) {
    const o = respField as Record<string, unknown>;
    // An object carrying NONE of our fields is a shape we do not understand,
    // and must say so. But an object with `kind` is a REAL verdict — including
    // `kind:"unclear"`, which is the model correctly declining. Marking that as
    // a failure would make every honest "I can't tell" look like a bug and
    // re-create exactly the noise this ticket removed.
    const known = ["kind", "business_name", "website", "products", "confidence", "rationale"];
    if (!known.some((k) => k in o)) {
      return unidentified(`unrecognized-object-shape keys=${Object.keys(o).slice(0, 6).join(",")}`);
    }
    return fromParsedObject(o);
  }

  // Older/other models return a string (possibly wrapped in prose or a fence).
  // Workers AI response shape varies by model: some return a string, some
  // { response: string }, and a non-string `.response` once crashed the email
  // entrypoint outright (OPE-189). Coerce defensively, exactly as
  // intent-classifier.ts does.
  const text = typeof raw === "string" ? raw : typeof respField === "string" ? respField : "";
  // OPE-403 follow-up — each bail says WHICH one it was. "empty-text" means the
  // model gave us nothing (or a shape we don't coerce); "no-json-span" means it
  // answered in prose; "json-parse-failed" means it tried JSON and malformed it.
  // Three different fixes, previously indistinguishable.
  if (!text.trim()) return unidentified(`empty-text raw=${describeRawShape(raw)}`);

  // Models often wrap JSON in prose or a ```json fence despite instructions.
  // Take the outermost {...} span rather than trusting the whole string.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    // Quote generously AND state the true length. On the first live occurrence
    // the quote stopped at 120 chars mid-word, which looked exactly like the
    // model being cut off — the log's own limit was mistaken for the evidence.
    const t = text.trim();
    return unidentified(`no-json-span len=${t.length} text="${t.slice(0, 240)}"`);
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch (e) {
    return unidentified(`json-parse-failed ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!obj || typeof obj !== "object") return unidentified("parsed-not-an-object");

  return fromParsedObject(obj);
}

/**
 * Run the vision model over one photo's bytes.
 *
 * Never throws: an AI failure returns UNIDENTIFIED so the batch continues and
 * the photo is staged for review rather than sinking the inbound workflow
 * (the OPE-189 lesson — a handler that throws kills the whole email).
 */
async function runOnce(ai: VisionAi, bytes: number[]): Promise<BoothIdentification> {
  try {
    const raw = await ai.run(VISION_MODEL, {
      // The binding expects a plain byte array, not a Uint8Array/ArrayBuffer.
      image: bytes,
      prompt: VISION_PROMPT,
      max_tokens: MAX_TOKENS,
    });
    return parseVisionReply(raw);
  } catch (e) {
    // OPE-403 follow-up — this used to swallow the error whole. An AI binding
    // that rejects (model not enabled, unsupported input shape, quota) is a
    // completely different problem from a reply we failed to parse, and both
    // arrived as the same "returned nothing usable".
    return unidentified(`ai-run-threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Identify one booth photo, retrying ONCE on an unusable reply.
 *
 * ── Why a retry, measured rather than guessed (OPE-403, 2026-08-16) ─────────
 * The model emits malformed output intermittently. Same photo, same prompt,
 * same `max_tokens: 384`, two calls:
 *
 *   prod  → unterminated JSON string, cut mid-token ("…\"hand-cro")
 *   probe → complete parsed object, completion_tokens 56, confidence 1,
 *           business_name "Mountain View Crochet Studio"
 *
 * So this is NOT the token cap (56 ≪ 384) and NOT the image. Cloudflare returns
 * a parsed OBJECT when the model's JSON is valid and the raw STRING when it is
 * not, which is why one photo produced `response=object` and the next
 * `no-json-span` — two symptoms, one intermittent cause.
 *
 * A retry is the honest fix. The alternative — a lenient parser that closes
 * dangling braces — would invent structure the model never emitted, on a path
 * whose output becomes a public factual claim about a real business. Rerunning
 * costs ~30 neurons (a fraction of a cent) and asks the model again rather than
 * guessing what it meant.
 *
 * Only retried when the FIRST attempt failed to parse. A genuine verdict —
 * including `kind:"unclear"`, the model declining — carries no `failureReason`
 * and is returned as-is, so a decisive "I can't tell" never costs a second call.
 */
export async function identifyBooth(ai: VisionAi, bytes: Uint8Array): Promise<BoothIdentification> {
  // Convert once: `Array.from` on a multi-MB photo is not free, and a retry
  // must not pay for it twice.
  const arr = Array.from(bytes);

  const first = await runOnce(ai, arr);
  if (!first.failureReason) return first;

  const second = await runOnce(ai, arr);
  if (!second.failureReason) return second;

  // Both failed. Report the SECOND reason but say it was retried, so a
  // persistent fault reads differently from a one-off in the logs.
  return unidentified(`${second.failureReason} (retried once; first: ${first.failureReason})`);
}

/**
 * Auto-write threshold.
 *
 * 0.75 is deliberately strict. The downstream write publishes a real business
 * as a CONFIRMED exhibitor at a real fair; a false positive is a public factual
 * claim about someone else's company. Staging costs John one review click,
 * so the asymmetry says: when in doubt, stage.
 */
export const AUTO_WRITE_CONFIDENCE = 0.75;

export type Disposition =
  | { action: "write"; identification: BoothIdentification }
  | { action: "stage"; identification: BoothIdentification; reason: string }
  | { action: "skip"; identification: BoothIdentification; reason: string };

/**
 * Decide what to do with one identified photo. Pure — the whole auto-write-vs-
 * stage judgment lives here so it can be exhaustively tested.
 */
export function disposition(id: BoothIdentification): Disposition {
  if (id.kind === "general") {
    // Gallery/hero handling for scenery is OPE-205, not this ticket.
    return { action: "skip", identification: id, reason: "general fair scene, not a booth" };
  }
  if (id.kind === "unclear") {
    return { action: "stage", identification: id, reason: "could not tell what the photo shows" };
  }
  if (!id.businessName) {
    return { action: "stage", identification: id, reason: "no legible business name on the booth" };
  }
  if (id.confidence < AUTO_WRITE_CONFIDENCE) {
    return {
      action: "stage",
      identification: id,
      reason: `confidence ${id.confidence.toFixed(2)} below ${AUTO_WRITE_CONFIDENCE} threshold`,
    };
  }
  return { action: "write", identification: id };
}
