/**
 * Event-lifecycle helpers for the MCP Worker.
 *
 * OPE-487 (2026-08-25): the transition map and its validator are no longer
 * duplicated here. They live in @takemetothefair/constants and are re-exported
 * below, so this worker, the main-app route and the OCCURRED sweep all enforce
 * ONE definition.
 *
 * The previous header admitted the arrangement's flaw outright — "Kept in sync
 * with the main-app definition BY HAND … CI doesn't catch drift" — and the
 * reason given for not sharing it ("would pull in the Drizzle-dependent
 * publicEventWhere()") is true of that whole module but not of the map, which
 * is pure. @takemetothefair/constants has no dependencies and this file already
 * imported EventLifecycle from it.
 *
 * That mattered more than tidiness here: a guard maintained as two hand-synced
 * copies fails by having one copy widened and the other not, which looks
 * enforced from whichever side you test.
 */
import { PUBLIC_LIFECYCLE_STATUSES, type EventLifecycle } from "@takemetothefair/constants";

export {
  LIFECYCLE_TRANSITIONS,
  TERMINAL_LIFECYCLE_STATUSES,
  validateLifecycleTransition,
} from "@takemetothefair/constants";
export type { TransitionResult, LifecycleTransitionContext } from "@takemetothefair/constants";

export function isPublicLifecycle(lifecycle: EventLifecycle): boolean {
  return (PUBLIC_LIFECYCLE_STATUSES as readonly string[]).includes(lifecycle);
}
