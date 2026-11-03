/**
 * OPE-1370 — the ONE outbound fetch for a URL we did not write ourselves.
 *
 * Before this, every fetcher of a user-, email- or page-supplied URL made its
 * own choices, and most of them made the same three mistakes (OPE-1355 audit,
 * SSRF4–SSRF7):
 *
 *   1. the SSRF host check ran on the FIRST hop only (or not at all), and
 *      `fetch` then followed 3xx unchecked — a public host can redirect to
 *      `http://127.0.0.1/` and the check never sees it;
 *   2. the body was read whole (`res.text()` / `res.arrayBuffer()`) before any
 *      size check, so one multi-GB response is a memory/CPU DoS;
 *   3. the timeout covered the headers but not always the body.
 *
 * `guardedFetch` closes all three:
 *
 *   - redirects are followed MANUALLY (`redirect: "manual"`), and protocol +
 *     `isBlockedSsrfHost` re-run on every hop, up to `maxRedirects`;
 *   - the body is read as a STREAM and the read is aborted the moment it
 *     passes `maxBytes` (a declared `Content-Length` over the cap is refused
 *     before a byte is read) — a typed `GuardedFetchError("too_large")`;
 *   - `timeoutMs` starts when the call starts and stays armed until the body
 *     has been read (or the caller cancels), so a slow-drip body times out too.
 *
 * Errors are thrown as `GuardedFetchError` with a stable `code`, EXCEPT an
 * abort caused by the caller's own `signal`, which is re-thrown as the
 * caller's AbortError — the caller owns that deadline and already knows how
 * to report it.
 *
 * ⚠️ Documented residual (unchanged from ssrf-guard.ts): DNS rebinding. The
 * host check is a string check and Workers expose no resolved IP. Accepted on
 * the Workers threat model — no metadata service, no internal HTTP network —
 * which also means the realistic risks this helper addresses are an open
 * proxy, memory/CPU exhaustion and cost, more than internal reachability.
 */
import { isBlockedSsrfHost } from "./ssrf-guard";

export type GuardedFetchErrorCode =
  | "invalid_url"
  | "blocked_protocol"
  | "blocked_host"
  | "too_many_redirects"
  | "redirect_without_location"
  | "invalid_redirect"
  | "too_large"
  | "timeout"
  | "network";

export class GuardedFetchError extends Error {
  readonly code: GuardedFetchErrorCode;
  /** HTTP status of the response involved, when there was one. */
  readonly status: number | null;
  /** The URL (hop) the error concerns. */
  readonly url: string;

  constructor(
    code: GuardedFetchErrorCode,
    message: string,
    opts: { status?: number | null; url?: string; cause?: unknown } = {}
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GuardedFetchError";
    this.code = code;
    this.status = opts.status ?? null;
    this.url = opts.url ?? "";
  }
}

export function isGuardedFetchError(e: unknown): e is GuardedFetchError {
  return e instanceof GuardedFetchError;
}

/** HTML pages: generous for a JS-heavy organizer page, far below a DoS. */
export const GUARDED_HTML_MAX_BYTES = 5 * 1024 * 1024;
/** Images: matches the existing 10 MB poster / image caps. */
export const GUARDED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const GUARDED_DEFAULT_TIMEOUT_MS = 15_000;
export const GUARDED_DEFAULT_MAX_REDIRECTS = 5;

export interface GuardedFetchOptions {
  /** Hard cap on body bytes. Reads past it abort with `too_large`. */
  maxBytes: number;
  /** Covers connect + headers + every redirect hop + the body read. 0 = none. */
  timeoutMs?: number;
  /** Redirect hops followed (each re-validated). 0 = a 3xx is an error. */
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Shorthand for the Accept header (overrides `headers.Accept`). */
  accept?: string;
  method?: "GET" | "HEAD";
  /** The caller's own deadline. Its abort is re-thrown as-is, not wrapped. */
  signal?: AbortSignal;
}

/** A fully-validated response whose body reads are size-capped. */
export interface GuardedResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  readonly headers: Headers;
  /** Final URL after the (validated) redirect chain. */
  readonly url: string;
  /** Number of redirect hops followed. */
  readonly redirects: number;
  /** Whole body, throws `too_large` past `maxBytes`. */
  bytes(): Promise<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /**
   * At most `limit` bytes (default `maxBytes`) of the body, read then the rest
   * discarded — for callers that only need a prefix (dimension probes, a page
   * scan that accepts a truncated tail). Never throws `too_large`.
   */
  bytesPrefix(limit?: number): Promise<Uint8Array>;
  textPrefix(limit?: number): Promise<string>;
  /** Discard the body and release the timer. Safe to call more than once. */
  cancel(): void;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

function isAbortLike(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    ((e as { name: string }).name === "AbortError" ||
      (e as { name: string }).name === "TimeoutError")
  );
}

/** Throws a SSRF/protocol GuardedFetchError if `u` must not be fetched. */
export function assertFetchableUrl(u: URL): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new GuardedFetchError("blocked_protocol", `Blocked protocol ${u.protocol}`, {
      url: u.href,
    });
  }
  if (isBlockedSsrfHost(u.hostname)) {
    throw new GuardedFetchError("blocked_host", `Blocked internal host ${u.hostname}`, {
      url: u.href,
    });
  }
}

export async function guardedFetch(
  rawUrl: string | URL,
  opts: GuardedFetchOptions
): Promise<GuardedResponse> {
  const maxBytes = opts.maxBytes;
  const timeoutMs = opts.timeoutMs ?? GUARDED_DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? GUARDED_DEFAULT_MAX_REDIRECTS;
  const method = opts.method ?? "GET";

  let current: URL;
  try {
    current = new URL(String(rawUrl));
  } catch {
    throw new GuardedFetchError("invalid_url", "Not a valid URL", { url: String(rawUrl) });
  }

  const timer = new AbortController();
  let timedOut = false;
  const timerId =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          timer.abort();
        }, timeoutMs)
      : null;
  const release = () => {
    if (timerId !== null) clearTimeout(timerId);
  };
  const signal = opts.signal ? anySignal([opts.signal, timer.signal]) : timer.signal;

  /** Translate an abort/network failure into the error the caller should see. */
  const translate = (err: unknown, url: string): unknown => {
    if (err instanceof GuardedFetchError) return err;
    if (opts.signal?.aborted && !timedOut) return err; // caller's deadline: theirs to report
    if (timedOut || isAbortLike(err)) {
      return new GuardedFetchError("timeout", `Timed out after ${timeoutMs}ms`, {
        url,
        cause: err,
      });
    }
    return new GuardedFetchError(
      "network",
      `network: ${err instanceof Error ? err.message : String(err)}`,
      { url, cause: err }
    );
  };

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.accept) headers.Accept = opts.accept;

  let resp: Response | null = null;
  let hops = 0;
  try {
    for (;;) {
      assertFetchableUrl(current);
      try {
        // Hop 0 goes out exactly as the caller spelled it (fetch normalizes it
        // the same way `new URL` just did for the check); later hops are the
        // resolved Location.
        const target = hops === 0 && typeof rawUrl === "string" ? rawUrl : current.href;
        resp = await fetch(target, { method, headers, signal, redirect: "manual" });
      } catch (err) {
        throw translate(err, current.href);
      }
      if (resp.status < 300 || resp.status >= 400 || resp.status === 304) break;

      // A redirect: never trust where it points until it has been checked.
      const loc = resp.headers.get("location");
      await resp.body?.cancel().catch(() => {});
      if (!loc) {
        throw new GuardedFetchError("redirect_without_location", "Redirect without Location", {
          status: resp.status,
          url: current.href,
        });
      }
      if (hops >= maxRedirects) {
        throw new GuardedFetchError("too_many_redirects", `More than ${maxRedirects} redirects`, {
          status: resp.status,
          url: current.href,
        });
      }
      try {
        current = new URL(loc, current);
      } catch {
        throw new GuardedFetchError("invalid_redirect", `Invalid redirect target ${loc}`, {
          status: resp.status,
          url: current.href,
        });
      }
      hops++;
    }
  } catch (err) {
    release();
    throw err;
  }

  const res = resp!;
  const finalUrl = current.href;

  const declared = Number(res.headers.get("content-length"));
  const declaredTooLarge = Number.isFinite(declared) && declared > maxBytes;

  let consumed = false;
  const cancel = () => {
    release();
    if (!consumed) {
      consumed = true;
      res.body?.cancel().catch(() => {});
    }
  };

  /**
   * Stream the body. `truncateAt` set → stop there and return the prefix;
   * unset → exceeding `maxBytes` is a `too_large` error.
   */
  const read = async (truncateAt?: number): Promise<Uint8Array> => {
    if (consumed) throw new TypeError("Body already consumed");
    consumed = true;
    const limit = truncateAt ?? maxBytes;
    try {
      if (truncateAt === undefined && declaredTooLarge) {
        throw new GuardedFetchError(
          "too_large",
          `Response is ${declared} bytes; the limit is ${maxBytes}`,
          { status: res.status, url: finalUrl }
        );
      }
      if (!res.body) return new Uint8Array(0);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await reader.read();
          } catch (err) {
            throw translate(err, finalUrl);
          }
          if (r.done) break;
          const chunk = r.value;
          if (total + chunk.byteLength > limit) {
            if (truncateAt === undefined) {
              throw new GuardedFetchError(
                "too_large",
                `Response exceeded the ${maxBytes}-byte limit`,
                { status: res.status, url: finalUrl }
              );
            }
            chunks.push(chunk.subarray(0, limit - total));
            total = limit;
            break;
          }
          chunks.push(chunk);
          total += chunk.byteLength;
          if (total === limit && truncateAt !== undefined) break;
        }
      } finally {
        // Stop the transfer — whatever is left is never read.
        timer.abort();
        await reader.cancel().catch(() => {});
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    } finally {
      release();
    }
  };

  const decode = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

  return {
    status: res.status,
    ok: res.ok,
    statusText: res.statusText,
    headers: res.headers,
    url: finalUrl,
    redirects: hops,
    bytes: () => read(),
    arrayBuffer: async () => {
      const b = await read();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    text: async () => decode(await read()),
    json: async () => JSON.parse(decode(await read())),
    bytesPrefix: (limit?: number) => read(Math.min(limit ?? maxBytes, maxBytes)),
    textPrefix: async (limit?: number) => decode(await read(Math.min(limit ?? maxBytes, maxBytes))),
    cancel,
  };
}
