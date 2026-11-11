/**
 * OPE-1625 — the structural no-write guard for every test submission.
 *
 * A dry run calls the REAL pipeline's read paths (findDuplicate, the import's
 * preview and diff, the promoter API's decision code). Those paths are reads,
 * but not all of them are pure: `autoLinkVenue` records an ambiguous venue
 * match to `admin_actions`, and any of them may log to `error_logs`. A test
 * submission must write nothing, so the engine never hands them the real
 * database — it hands them this wrapper, whose write entry points THROW.
 *
 * Throwing (not silently dropping) is deliberate: a write a dry-run path did
 * not expect surfaces as a failure in tests instead of passing unnoticed. The
 * best-effort writers the read paths already contain (the venue audit row,
 * `logError`) catch their own failures, so a suppressed audit write does not
 * fail the dry run. Every refused write is reported to `onBlocked`.
 *
 * Blocked: insert / update / delete, raw `run` / `exec`, `batch`,
 * `transaction`, and the raw client (`$client`). Reads (`select`, `query`,
 * `all`, `get`, `values`, `$count`) pass through. `with(...)` returns a
 * builder that can also write, so it is wrapped the same way.
 */
export class DryRunWriteError extends Error {
  readonly op: string;
  constructor(op: string) {
    super(`dry run: refused a database write (${op})`);
    this.name = "DryRunWriteError";
    this.op = op;
  }
}

const BLOCKED = new Set([
  "insert",
  "update",
  "delete",
  "run",
  "exec",
  "batch",
  "transaction",
  "$client",
]);
const WRAPPED_BUILDERS = new Set(["with", "$with"]);
/** Answered `true` by the wrapper only — the real database never carries it. */
const READ_ONLY = Symbol.for("mmatf.test-submission.read-only");

/** True only for a handle made by `readOnlyDb`. */
export function isReadOnlyDb(db: unknown): boolean {
  return !!db && typeof db === "object" && (db as Record<symbol, unknown>)[READ_ONLY] === true;
}

/** The engine refuses any database handle that is not the read-only wrapper. */
export function assertReadOnly(db: unknown): void {
  if (!isReadOnlyDb(db))
    throw new Error("test-submission: pass readOnlyDb(db), never the real database");
}

export function readOnlyDb<T extends object>(db: T, onBlocked?: (op: string) => void): T {
  const refuse = (op: string): never => {
    onBlocked?.(op);
    throw new DryRunWriteError(op);
  };
  const wrap = <U extends object>(target: U): U =>
    new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === READ_ONLY) return true;
        if (typeof prop === "string" && BLOCKED.has(prop)) {
          if (prop === "$client") return refuse("$client");
          return () => refuse(prop);
        }
        const value = Reflect.get(t, prop, receiver);
        if (typeof prop === "string" && WRAPPED_BUILDERS.has(prop) && typeof value === "function") {
          return (...args: unknown[]) => {
            const built = (value as (...a: unknown[]) => unknown).apply(t, args);
            return built && typeof built === "object" ? wrap(built as object) : built;
          };
        }
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return wrap(db);
}
