/**
 * OPE-969 rework — find the JSON answer inside a model's TEXT reply.
 *
 * Every Workers AI parser in this Worker that reads a string reply did the same
 * thing: `text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)`. That greedy
 * span is wrong whenever the reply carries a brace AFTER the answer — a fenced
 * object followed by a "Note: {…}" line, two objects, a rationale string with a
 * `}` in prose after the close — because the span then runs from the first
 * object's open brace to the LAST close brace anywhere, and JSON.parse rejects
 * the whole thing although a complete answer sat at the front of it.
 *
 * This is the one shared replacement:
 *  1. strip a markdown code fence (``` or ```json …), including an opening
 *     fence the model never closed (a truncated reply);
 *  2. scan for the first BALANCED top-level value of the wanted kind —
 *     string-aware (a `}` inside "…" does not close anything) and escape-aware;
 *  3. JSON.parse that span; if it does not parse, try the next TOP-LEVEL
 *     candidate after it (never one nested inside it).
 *
 * It never repairs anything. A reply with no complete balanced value is
 * reported as `no-json-span` (unterminated: true when an opener WAS seen — a
 * truncated object), and a balanced span that is not JSON as
 * `json-parse-failed`. Closing a dangling brace would invent structure the model
 * never emitted; on the photo lane that output becomes a public claim about a
 * real business (see vision.ts identifyBooth).
 */

export type JsonKind = "object" | "array";

export type JsonSpanResult =
  | { ok: true; value: unknown; span: string }
  | {
      ok: false;
      reason: "no-json-span" | "json-parse-failed";
      /** An opener of the wanted kind was present but never balanced — truncation. */
      unterminated: boolean;
      /** The first JSON.parse error message, for `json-parse-failed`. */
      detail?: string;
    };

/**
 * The inside of the first markdown code fence, or the text unchanged when there
 * is none. An opening fence with no closing one yields everything after it — a
 * reply cut off by the token cap still has its (partial) body examined, and the
 * balanced scan then decides whether anything complete is in there.
 */
export function stripCodeFences(text: string): string {
  const open = text.match(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?/);
  if (!open || open.index === undefined) return text;
  const bodyStart = open.index + open[0].length;
  const close = text.indexOf("```", bodyStart);
  return close === -1 ? text.slice(bodyStart) : text.slice(bodyStart, close);
}

/**
 * Index one past the close of the balanced value opening at `s[from]`; -1 when
 * it never closes (truncated), -2 on a mismatched closer (`{"a":1]`, not JSON). String- and escape-aware; tracks `{}` and `[]` together
 * so `{"a":[1,{"b":2}]}` balances on its own outer brace.
 */
export function balancedEnd(s: string, from: number): number {
  const stack: string[] = [];
  let inStr = false;
  let escape = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") {
      // A mismatched closer means this candidate is not a JSON value.
      if (stack.pop() !== c) return -2;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The first complete JSON value of `kind` in a model's text reply. Pure + total.
 */
export function extractJsonValue(text: string, kind: JsonKind = "object"): JsonSpanResult {
  const inner = stripCodeFences(text);
  const first = scan(inner, kind);
  // A fence that held something else (an example, a table) must not hide an
  // answer outside it, so a miss inside the fence falls back to the whole text.
  if (first.ok || inner === text) return first;
  const whole = scan(text, kind);
  return whole.ok ? whole : first;
}

function scan(s: string, kind: JsonKind): JsonSpanResult {
  const opener = kind === "object" ? "{" : "[";
  let unterminated = false;
  let firstError: string | undefined;

  // Candidates are TOP-LEVEL only. After a balanced-but-unparseable span the
  // scan resumes past its end, and an unterminated or mismatched opener stops
  // the scan: every later brace is inside it, and returning a nested fragment
  // (`{"b":1}` out of a cut-off `{"a":{"b":1},"c":"…`) would hand back a piece
  // as the answer.
  let i = s.indexOf(opener);
  while (i !== -1) {
    const end = balancedEnd(s, i);
    if (end === -1) {
      unterminated = true;
      break;
    }
    if (end === -2) {
      firstError ??= "mismatched bracket";
      break;
    }
    const span = s.slice(i, end);
    try {
      const value: unknown = JSON.parse(span);
      const right =
        kind === "array"
          ? Array.isArray(value)
          : value !== null && typeof value === "object" && !Array.isArray(value);
      if (right) return { ok: true, value, span };
    } catch (e) {
      firstError ??= e instanceof Error ? e.message : String(e);
    }
    i = s.indexOf(opener, end);
  }

  if (firstError !== undefined) {
    return { ok: false, reason: "json-parse-failed", unterminated, detail: firstError };
  }
  return { ok: false, reason: "no-json-span", unterminated };
}

/** Convenience: the first complete JSON OBJECT, or null. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const r = extractJsonValue(text, "object");
  return r.ok ? (r.value as Record<string, unknown>) : null;
}
