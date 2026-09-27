/**
 * OPE-1172 — how a client reads `/api/auth/send-verification`'s answer.
 *
 * Client-safe (no DB imports). Shared by the resend button and the unverified
 * banner so the two surfaces cannot disagree about what "undeliverable" looks
 * like — before this, both read only `res.ok`, which is how a doomed resend was
 * reported to the user as "Check your inbox".
 */
export type ResendOutcome =
  | { kind: "sent" }
  | { kind: "undeliverable"; email: string }
  | { kind: "error" };

export async function readResendOutcome(
  res: Response,
  fallbackEmail: string
): Promise<ResendOutcome> {
  if (res.ok) return { kind: "sent" };
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as {
      undeliverable?: unknown;
      email?: unknown;
    };
    if (body.undeliverable === true) {
      return {
        kind: "undeliverable",
        email: typeof body.email === "string" && body.email ? body.email : fallbackEmail,
      };
    }
  }
  return { kind: "error" };
}
