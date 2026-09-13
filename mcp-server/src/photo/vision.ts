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

/**
 * OPE-969 — what a photo IS. Was booth | general | unclear, and real fair photos
 * do not divide that way: on the first real batch (New Gloucester, 2026-09-12)
 * a youth cheer squad mid-routine was staged as a nameless BOOTH selling
 * "cheerleading uniforms", and a livestock pen and a bounce house were staged
 * as nameless booths too — the model had nowhere else to put them.
 *
 *  - booth      an exhibitor's stall/table is the subject (incl. non-profits
 *               whose sign is an information board)
 *  - performer  an act is the subject — no class existed, so no path could
 *               ever put the photo's act on the event's lineup
 *  - scenery    the fair itself; the gallery. `general` in replies from the
 *               old prompt is read as this.
 *  - signage    a sign whose owner is NOT the subject (a neighbour's banner, a
 *               sponsor sign) — recorded, never a proposal
 *  - unclear    the model declined
 */
export type PhotoKind = "booth" | "performer" | "scenery" | "signage" | "unclear";
/** @deprecated the pre-OPE-969 name; kept so imports do not churn. */
export type BoothKind = PhotoKind;

export interface BoothIdentification {
  /** What the photo is — see PhotoKind. */
  kind: PhotoKind;
  /** Business name EXACTLY as it appears on signage, or null. Booths only. */
  businessName: string | null;
  /** OPE-969 — the act's name EXACTLY as printed on its own banner, backdrop,
   *  truck or costume. Performers only; never inferred from what they do. */
  performerName: string | null;
  /** OPE-969 — for `signage`, the sign's text: the record of whose banner it
   *  was, so the false positive is visible rather than silently dropped. */
  signText: string | null;
  /** Only when legibly printed on the sign. Never inferred from the name. */
  website: string | null;
  /** What they sell, if evident. Free-form short tokens. */
  products: string[];
  /** Model's self-reported confidence, clamped 0..1. */
  confidence: number;
  /** Short reason — surfaced to the operator when staging for review. */
  rationale: string;
  /**
   * OPE-240 — does an identifiable CHILD appear in the photo?
   *
   * John's standing rule (2026-07-21): vendor and staff faces are fine, but a
   * photo where a child is identifiable is never published. With auto-write on,
   * the booth photo becomes the vendor's public hero with no human in the path,
   * so that rule has to live in the gate rather than in an analyst's eye.
   *
   * `true` / `false` only when the model answered with a boolean. Anything else
   * — omitted, a string, a malformed reply — is `null`, and `disposition()`
   * treats null exactly like `true`: an unanswered question does not publish.
   */
  identifiableMinor: boolean | null;
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
  performerName: null,
  signText: null,
  website: null,
  products: [],
  confidence: 0,
  rationale: "vision model returned nothing usable",
  identifiableMinor: null,
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

/**
 * OPE-969 — measured on the 18 real New Gloucester photos (2026-09-13), not
 * tuned by eye. Three findings shaped it:
 *
 *  - LENGTH COSTS JSON. A fuller prompt spelling out each class answered in
 *    prose on 2 of 3 runs; this compact one (the same size as the old one) with
 *    JSON mode returned an object on 16 of 18.
 *  - ONE `name` FIELD. Separate business/performer/sign fields were more for an
 *    11B model to track; the kind says whose name it is (see fromParsedObject).
 *  - THE CHILD RULE IS SHORTER TOO. The old wording returned
 *    identifiable_minor:false for a squad of ~25 girls and for a bounce house
 *    full of children; this returned true for both.
 *
 * Before → after on the corpus: cheer squad booth→performer, livestock pen
 * booth→scenery, trail-map board unnamed→"Casco Bay Trail" + its website; every
 * booth whose reply parsed (13 of 15) still a booth. Unchanged: the bounce house is still read as a
 * nameless booth (it stages, as it did), and "Joelsa" still misreads as
 * "Toolsa" — with the OLD prompt too, once at confidence 1.0.
 */
export const VISION_PROMPT = `You are looking at ONE photograph taken at a public agricultural fair or craft show.

Decide what the photo IS, then report only what you can actually READ or SEE.

Rules — follow exactly:
1. kind = "booth" if an exhibitor's booth/stall/tent/table is the MAIN SUBJECT
   (clubs and non-profits count; their display board or map is their sign).
2. kind = "performer" if people PERFORMING are the main subject (stage, ring,
   routine, band, show) or an act's own truck. Performers sell nothing.
3. kind = "scenery" for rides, bounce houses, crowds, animals, pens, grounds.
4. kind = "signage" if the only legible sign belongs to someone who is NOT the
   subject (a banner behind a different booth, a sponsor sign).
5. If you cannot tell, kind = "unclear".
6. name: EXACTLY as printed on the subject's OWN sign, banner, board or truck.
   Never a description. If none is legible, null.
7. website: ONLY if a web address is legibly printed. Otherwise null.
8. products: short lowercase words, booths only, ONLY if visible.
9. confidence: 0.0-1.0. LOW (<0.5) if the sign is obscured, blurry or angled.
10. NEVER invent a name, URL, phone number, or town.
11. identifiable_minor: true if ANY child or teenager appears anywhere in the
    photo. false only if you are sure none does. When unsure, answer true.

Reply with ONLY a JSON object, no prose, no markdown fence:
{"kind":"booth|performer|scenery|signage|unclear","name":string|null,"website":string|null,"products":[string],"confidence":number,"rationale":string,"identifiable_minor":boolean}`;

/**
 * OPE-969 — Workers AI JSON mode. Constrains `kind` to the enum and removes
 * most prose replies (the retry in identifyBooth covers the rest: 2 of 18 still
 * came back as strings on the measured run).
 */
export const VISION_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["booth", "performer", "scenery", "signage", "unclear"] },
      name: { type: ["string", "null"] },
      website: { type: ["string", "null"] },
      products: { type: "array", items: { type: "string" } },
      confidence: { type: "number" },
      rationale: { type: "string" },
      identifiable_minor: { type: "boolean" },
    },
    required: [
      "kind",
      "name",
      "website",
      "products",
      "confidence",
      "rationale",
      "identifiable_minor",
    ],
  },
} as const;

/** Minimal shape of the Workers AI binding we need. */
export interface VisionAi {
  run(
    model: string,
    input: {
      image: number[];
      prompt: string;
      max_tokens?: number;
      response_format?: typeof VISION_RESPONSE_FORMAT;
    }
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
 * OPE-969 — a website must at least LOOK like one. Measured at confidence 1.0
 * on real booths: `"noshop/bybinkcrafts"` (By-B) and `"Watercolors by Carolyn
 * Smith"` (a tagline read into the website field). Both would have cleared the
 * auto-write bar and been published as a vendor's link. A dotted host with no
 * whitespace is the floor; anything else is null — missing, not invented.
 */
const WEBSITE_SHAPE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

export function cleanWebsite(v: unknown): string | null {
  const s = cleanString(v, 300);
  return s && WEBSITE_SHAPE.test(s) ? s : null;
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
  const kind: PhotoKind =
    (
      {
        booth: "booth",
        performer: "performer",
        scenery: "scenery",
        // The pre-OPE-969 prompt's word for scenery. A replay of a stored reply,
        // or a model that echoes the old vocabulary, still lands in the gallery.
        general: "scenery",
        signage: "signage",
      } as Record<string, PhotoKind>
    )[rawKind] ?? "unclear";

  const products = Array.isArray(obj.products)
    ? obj.products
        .map((p) => cleanString(p, 60))
        .filter((p): p is string => p !== null)
        .slice(0, 12)
    : [];

  const website = cleanWebsite(obj.website);
  // The prompt asks for one `name`; a reply in the pre-OPE-969 shape carries
  // `business_name`. Either is read, and the KIND decides whose name it is.
  const name = cleanString(obj.name) ?? cleanString(obj.business_name);

  return {
    kind,
    // Each name is kept ONLY for its own kind. A scenery shot can never carry a
    // vendor into the write path, and a performer photo never carries a
    // business name (the cheer squad's "products" were its uniforms).
    businessName: kind === "booth" ? name : null,
    performerName: kind === "performer" ? name : null,
    signText: kind === "signage" ? name : null,
    website: kind === "booth" ? website : null,
    products: kind === "booth" ? products : [],
    confidence: clamp01(obj.confidence),
    rationale: cleanString(obj.rationale, 300) ?? "",
    // Strict: only a real boolean counts. "false" as a STRING is not an answer
    // we trust to publish a photo on.
    identifiableMinor: typeof obj.identifiable_minor === "boolean" ? obj.identifiable_minor : null,
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
    const known = [
      "kind",
      "name",
      "business_name",
      "website",
      "products",
      "confidence",
      "rationale",
    ];
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
      response_format: VISION_RESPONSE_FORMAT,
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
 * Auto-write threshold — 1.0, John's ruling 2026-09-12 (OPE-240).
 *
 * The downstream write publishes a real business as a CONFIRMED exhibitor at a
 * real fair; a false positive is a public factual claim about someone else's
 * company. Staging costs John one review click, so: when in doubt, stage.
 *
 * Why 1.0 and not the original 0.75: on the first real batch (New Gloucester
 * Community Fair, 2026-09-12, 12 would-write proposals checked against the
 * photos by hand) 11 were right and ONE was a fabricated business — a script
 * "Denim River Crafts" banner read as "Bayim River Crafts" at confidence 0.90.
 * The failure is confident misreading, not uncertainty, so no bar short of 1.0
 * catches it. All four 1.0 proposals were correct. n=12 is small: revisit
 * against accumulated `list_photo_proposals` evidence, not a hunch.
 */
export const AUTO_WRITE_CONFIDENCE = 1.0;

/**
 * OPE-969 — WHY a photo staged, as a closed vocabulary. The free-text
 * `stage_reason` "no legible business name on the booth" used to cover a real
 * booth whose sign was unreadable AND a livestock pen the model had no other
 * word for — two situations needing opposite follow-up, indistinguishable in
 * `list_photo_proposals`. Every staged row now carries one of these.
 */
export type StageKind =
  | "unclear"
  | "booth_name_unreadable"
  | "booth_below_threshold"
  | "booth_identifiable_minor"
  | "booth_roster_check_failed"
  | "performer_unnamed"
  | "performer_unmatched"
  | "performer_not_on_roster"
  | "performer_identifiable_minor";

export type Disposition =
  | { action: "write"; identification: BoothIdentification }
  | { action: "stage"; identification: BoothIdentification; reason: string; stageKind: StageKind }
  /** Scenery — the gallery (OPE-205 §3). */
  | { action: "skip"; identification: BoothIdentification; reason: string }
  /** A named act — resolved against the performer table and the event roster by the pipeline. */
  | { action: "performer"; identification: BoothIdentification }
  /** Signage ≠ presence — recorded, nothing written. */
  | { action: "record"; identification: BoothIdentification; reason: string };

/**
 * Decide what to do with one identified photo. Pure — the whole auto-write-vs-
 * stage judgment lives here so it can be exhaustively tested.
 */
export function disposition(id: BoothIdentification): Disposition {
  if (id.kind === "scenery") {
    return { action: "skip", identification: id, reason: "fair scenery — gallery" };
  }
  if (id.kind === "signage") {
    return {
      action: "record",
      identification: id,
      reason: "signage for a party whose own booth is not the subject — not presence",
    };
  }
  if (id.kind === "performer") {
    if (!id.performerName) {
      return {
        action: "stage",
        identification: id,
        reason: "a performance, but no act name is printed",
        stageKind: "performer_unnamed",
      };
    }
    return { action: "performer", identification: id };
  }
  if (id.kind === "unclear") {
    return {
      action: "stage",
      identification: id,
      reason: "could not tell what the photo shows",
      stageKind: "unclear",
    };
  }
  if (!id.businessName) {
    return {
      action: "stage",
      identification: id,
      reason: "a booth, but its name is not legible",
      stageKind: "booth_name_unreadable",
    };
  }
  if (id.confidence < AUTO_WRITE_CONFIDENCE) {
    return {
      action: "stage",
      identification: id,
      reason: `confidence ${id.confidence.toFixed(2)} below ${AUTO_WRITE_CONFIDENCE} threshold`,
      stageKind: "booth_below_threshold",
    };
  }
  // OPE-240 — John's faces rule, as a gate. Checked LAST so a photo that would
  // otherwise publish is the one that reports it; `null` (the model did not
  // answer) stages exactly like `true`.
  if (id.identifiableMinor !== false) {
    return {
      action: "stage",
      identification: id,
      reason:
        id.identifiableMinor === true
          ? "an identifiable child appears in the photo — never auto-published"
          : "child check not answered — never auto-published without it",
      stageKind: "booth_identifiable_minor",
    };
  }
  return { action: "write", identification: id };
}
