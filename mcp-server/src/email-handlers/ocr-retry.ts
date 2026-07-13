/**
 * OPE-189 — retrying wrapper around `env.AI.toMarkdown` for attachment OCR.
 *
 * Root cause of the "poster emails create 0 events" bug: the image→markdown
 * vision model (`@cf/google/gemma-4-26b-a4b-it`) times out on the FIRST call
 * after a cold start ("AI binding timed out after 60000ms"), and `toMarkdown`
 * surfaces that as a `{format:"error"}` result rather than a throw. The old
 * ocrAttachments treated that single error as a permanent drop and returned no
 * source — even though a warm retry ~40s later reads the poster fine (2,233
 * chars in the repro). The successful read was stranded and the email bounced.
 *
 * This helper retries a transient failure (timeout / capacity / rate-limit) in
 * place, up to `maxAttempts`, so a cold-start miss on attempt 1 is recovered
 * synchronously within the same workflow step — the resulting source then drives
 * event creation deterministically instead of racing a step-level retry that
 * fires after the bounce already committed. Non-transient errors (a genuinely
 * unreadable file) fail fast without burning the retry budget.
 */

/** A single document to convert — mirrors the `env.AI.toMarkdown` input shape. */
export interface ToMarkdownDoc {
  name: string;
  blob: Blob;
}

/** The per-document result shape `env.AI.toMarkdown` yields (union-narrowed). */
export type ToMarkdownResult =
  | { format: "markdown"; data?: unknown; [k: string]: unknown }
  | { format: "error"; error?: unknown; [k: string]: unknown }
  | { format?: unknown; [k: string]: unknown };

/** Minimal structural view of the Workers AI binding we depend on. */
export interface ToMarkdownAi {
  toMarkdown(docs: ToMarkdownDoc[]): Promise<ToMarkdownResult[] | ToMarkdownResult>;
}

export interface ToMarkdownOutcome {
  /** The converted text when a `markdown` result was obtained, else null. */
  text: string | null;
  /** How many attempts were made (1-based). */
  attempts: number;
  /** Terminal outcome tag for the caller's log line (e.g. `ok:2233chars`). */
  outcome: string;
}

/**
 * True for AI-binding errors that a warm retry is likely to clear: cold-start
 * timeouts, capacity/overload, rate limits. A genuinely malformed file returns
 * a stable error we should NOT keep hammering.
 */
export function isTransientAiError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("capacity") ||
    m.includes("overload") ||
    m.includes("rate limit") ||
    m.includes("rate-limit") ||
    m.includes("too many requests") ||
    m.includes("429") ||
    m.includes("5028") || // Workers AI "no healthy upstream" / model-load class
    m.includes("503")
  );
}

/**
 * Convert one document to markdown, retrying transient failures up to
 * `maxAttempts` times. `onAttempt(attempt, outcome)` fires once per attempt so
 * the caller can log every path (the OPE-189 observability contract) — the
 * cold-start timeout on attempt 1 is still recorded even when attempt 2 wins.
 *
 * Never throws: a thrown toMarkdown (vs the `{format:"error"}` variant) is
 * caught and treated the same way — retried if transient, else terminal.
 */
export async function toMarkdownWithRetry(
  ai: ToMarkdownAi,
  doc: ToMarkdownDoc,
  maxAttempts: number,
  onAttempt?: (attempt: number, outcome: string) => void
): Promise<ToMarkdownOutcome> {
  let outcome = "unknown";
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let first: ToMarkdownResult | undefined;
    try {
      const results = await ai.toMarkdown([doc]);
      first = Array.isArray(results) ? results[0] : results;
    } catch (err) {
      outcome = `threw:${err instanceof Error ? err.message : String(err)}`.slice(0, 220);
      onAttempt?.(attempt, outcome);
      if (attempt < attempts && isTransientAiError(outcome)) continue;
      return { text: null, attempts: attempt, outcome };
    }

    if (first && first.format === "markdown") {
      const data = (first as { data?: unknown }).data;
      const text = typeof data === "string" ? data : "";
      outcome = `ok:${text.trim().length}chars`;
      onAttempt?.(attempt, outcome);
      return { text, attempts: attempt, outcome };
    }
    if (first && first.format === "error") {
      const err = String((first as { error?: unknown }).error ?? "");
      outcome = `toMarkdown-error:${err.slice(0, 200)}`;
      onAttempt?.(attempt, outcome);
      if (attempt < attempts && isTransientAiError(err)) continue;
      return { text: null, attempts: attempt, outcome };
    }
    // Unexpected shape — not retryable.
    outcome = `unexpected-shape:${first ? JSON.stringify(first).slice(0, 150) : "null"}`;
    onAttempt?.(attempt, outcome);
    return { text: null, attempts: attempt, outcome };
  }
  return { text: null, attempts, outcome };
}
