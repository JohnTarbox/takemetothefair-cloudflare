/**
 * Stub for the `cloudflare:workflows` virtual module used in node-pool
 * unit tests. The real module is provided by the workers runtime; here
 * we only need a NonRetryableError class with the same instanceof and
 * .name semantics the workflow runtime gives us.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}
