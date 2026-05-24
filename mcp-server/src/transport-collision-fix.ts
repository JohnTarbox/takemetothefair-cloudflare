// Routing fix for upstream issue #1186 — "Zombie Task Collision in
// StreamableHTTPServerTransport". See the longer explanation in index.ts
// `onStart` for the bug's history and production manifestation.
//
// The agents/mcp StreamableHTTPServerTransport routes responses by walking
// `agent.getConnections()` and picking the first connection whose
// `state.requestIds` includes the response's request id. When two concurrent
// JSON-RPC requests share a request id (across two sessions, or one client
// reusing ids on parallel POSTs), `find()` matches arbitrarily — the response
// for tool A can be written to client B's HTTP socket with the wrong shape.
//
// The functions in this module let us:
//   1. Decide at send time whether the original routing is correct,
//      whether we can fix it from intake state, or whether we must refuse.
//   2. Direct-write a response to a known-correct connection, bypassing
//      the buggy `find()`.

export interface ConnectionState {
  requestIds?: unknown[];
}

export interface ConnectionLike {
  id: string;
  state?: ConnectionState;
}

export type RouteDecision =
  | { kind: "passthrough" }
  | { kind: "fixed"; connection: ConnectionLike }
  | { kind: "ambiguous"; matchedIds: readonly string[] };

/**
 * Decide how to route a `transport.send(requestId)` call.
 *
 *  - **passthrough**: no `requestId`, or ≤1 connection matches — the
 *    original transport behavior is correct; defer to it.
 *  - **fixed**: ≥2 connections match (collision) AND `trackedConnectionId`
 *    identifies one of them — direct-write to that connection.
 *  - **ambiguous**: ≥2 connections match AND no tracked connection
 *    disambiguates — refuse to send. Caller should surface a deterministic
 *    error rather than risk a wrong-shape response.
 */
export function decideSendRouting(
  connections: readonly ConnectionLike[],
  requestId: unknown,
  trackedConnectionId: string | undefined
): RouteDecision {
  if (requestId === undefined || requestId === null) {
    return { kind: "passthrough" };
  }

  const matches = connections.filter((c) => {
    const ids = c.state?.requestIds;
    return Array.isArray(ids) && ids.includes(requestId);
  });

  if (matches.length <= 1) {
    return { kind: "passthrough" };
  }

  if (trackedConnectionId) {
    const correct = matches.find((c) => c.id === trackedConnectionId);
    if (correct) {
      return { kind: "fixed", connection: correct };
    }
  }

  return { kind: "ambiguous", matchedIds: matches.map((c) => c.id) };
}

/**
 * Minimal shape of the upstream `StreamableHTTPServerTransport` private
 * surface we depend on. Reaching into these underscored members is fragile;
 * see comment in `index.ts` `onStart` for the upstream removal condition.
 */
export interface TransportPrivates {
  _eventStore?: { storeEvent: (connectionId: string, message: unknown) => Promise<string> };
  _requestResponseMap?: Map<unknown, unknown>;
  writeSSEEvent: (
    connection: ConnectionLike,
    message: unknown,
    eventId: string | undefined,
    close?: boolean
  ) => unknown;
}

/**
 * Direct-write replacement for the buggy `find()`-based routing in
 * agents/mcp's `transport.send`. Mirrors what the original does at the
 * `writeSSEEvent` layer but with a known-correct `connection`.
 *
 * Only the response-message branch of `send` is reimplemented — notifications
 * are uninvolved in the collision because they don't carry a request id.
 */
export async function sendViaConnection(
  transport: TransportPrivates,
  connection: ConnectionLike,
  message: unknown,
  requestId: unknown
): Promise<void> {
  let eventId: string | undefined;
  if (transport._eventStore) {
    eventId = await transport._eventStore.storeEvent(connection.id, message);
  }

  let shouldClose = false;
  if (isResponseMessage(message)) {
    transport._requestResponseMap?.set(requestId, message);
    const relatedIds = connection.state?.requestIds ?? [];
    shouldClose = relatedIds.every((id) => transport._requestResponseMap?.has(id) ?? false);
    if (shouldClose) {
      for (const id of relatedIds) transport._requestResponseMap?.delete(id);
    }
  }

  transport.writeSSEEvent(connection, message, eventId, shouldClose);
}

/**
 * JSON-RPC response detector. A response carries `id` and either `result` or
 * `error`. Notifications have no id; requests have `method`. We only care
 * about responses here because the routing fix is response-specific.
 */
function isResponseMessage(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const obj = m as Record<string, unknown>;
  if (!("id" in obj)) return false;
  return "result" in obj || "error" in obj;
}
