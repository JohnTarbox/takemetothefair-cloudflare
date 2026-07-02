/**
 * OPE-66 — server-side GA4 claim-funnel events (Measurement Protocol).
 *
 * The claim funnel converted ~0 for months because nothing measured it. These
 * four events instrument it end-to-end with the ENG1.8 `_server`-suffix pattern:
 * fired server-to-server via the Measurement Protocol so ad-blockers cannot
 * suppress them (unlike the client gtag hit). The distinct `_server` names also
 * avoid double-counting against any client-side emit for the same step.
 *
 *   claim_view_server                    — funnel entry (viewed the claim opportunity)
 *   claim_account_created_server         — account created with a claim in flight
 *   claim_verification_attempted_server  — a verification method was attempted
 *   claim_completed_server               — claim approved (ownership granted)
 *
 * Custom dimensions:
 *   entity_type  reused — lowercase, matching ENG1.8's `entity_type: "event"`.
 *   entity_id    reused — the public SLUG (ENG1.8 uses the slug for `entity_id`;
 *                keeping that convention makes the value human-readable in GA4
 *                and lets the smoke-test filter match on readable slugs).
 *   method       NEW — register in GA4 Admin → Custom Definitions (operator
 *                step; see docs/ope66-ga4-custom-dimensions.md). Until then the
 *                event still lands (Realtime/DebugView) — only the param column
 *                is empty in standard reports.
 *
 * Like all analytics in this codebase these NEVER throw and are inert until the
 * GA4 MP env vars are configured (sendGa4MeasurementProtocol handles both).
 *
 * OPE-64's claim wizard will import these helpers to fire the same four events
 * from its steps; this module is the single source of the event contract.
 */
import { sendGa4MeasurementProtocol } from "@/lib/ga4-measurement-protocol";

export type ClaimEntityType = "VENDOR" | "PROMOTER";

/**
 * Verification-ladder rungs (spec §4). EMAIL_MATCH / EVIDENCE are live today;
 * DOMAIN_MATCH / MAGIC_LINK land with the OPE-64 wizard; ADMIN is an operator
 * grant. Kept as a closed union so the `method` custom dimension has a stable,
 * documented value set.
 */
export type ClaimMethod = "EMAIL_MATCH" | "DOMAIN_MATCH" | "MAGIC_LINK" | "EVIDENCE" | "ADMIN";

// Smoke-test entities excluded from the GA4 funnel so operator/CI test claims
// (e.g. the `test-vendor` fixture used by send_test_email's claim_invite
// template) don't inflate conversions. No prior code-level convention existed —
// this is the single filter point; add real smoke-test slugs here.
const SMOKE_TEST_ENTITY_IDS = new Set<string>(["test-vendor", "test-vendor-co", "test-promoter"]);

/**
 * True when the entity_id (public slug) belongs to a smoke test and must be
 * kept out of GA4. Also treats empty/whitespace as filterable — an absent slug
 * carries no funnel signal and would only create a phantom `(not set)` bucket.
 */
export function isSmokeTestEntityId(entityId: string): boolean {
  const v = entityId.trim().toLowerCase();
  return v === "" || v.includes("smoke-test") || SMOKE_TEST_ENTITY_IDS.has(v);
}

/**
 * Lowercase the entity_type for the GA4 custom dimension, matching the ENG1.8
 * outbound-click convention (`entity_type: "event"`).
 */
function entityTypeDim(entityType: ClaimEntityType): string {
  return entityType === "VENDOR" ? "vendor" : "promoter";
}

interface ClaimEventArgs {
  /**
   * GA4 client_id (from the `_ga` cookie via parseGaClientId), or a random
   * fallback so the event still lands (as a new user) when the cookie is
   * absent — e.g. a verification-link click from an email client.
   */
  clientId: string;
  entityType: ClaimEntityType;
  /**
   * The entity's PUBLIC SLUG — surfaced as the `entity_id` custom dimension
   * (matching ENG1.8, which uses the event slug for `entity_id`).
   */
  entitySlug: string;
}

async function fireClaimEvent(
  clientId: string,
  name: string,
  entityType: ClaimEntityType,
  entitySlug: string,
  extra?: Record<string, string | number>
): Promise<void> {
  await sendGa4MeasurementProtocol(clientId, [
    {
      name,
      params: {
        transport: "server",
        entity_type: entityTypeDim(entityType),
        entity_id: entitySlug,
        ...extra,
      },
    },
  ]);
}

/** Funnel entry — the visitor viewed the claim opportunity. */
export async function trackClaimViewServer({
  clientId,
  entityType,
  entitySlug,
}: ClaimEventArgs): Promise<void> {
  if (isSmokeTestEntityId(entitySlug)) return;
  await fireClaimEvent(clientId, "claim_view_server", entityType, entitySlug);
}

/** Account created with a claim in flight (register funnel, claim= present). */
export async function trackClaimAccountCreatedServer({
  clientId,
  entityType,
  entitySlug,
}: ClaimEventArgs): Promise<void> {
  if (isSmokeTestEntityId(entitySlug)) return;
  await fireClaimEvent(clientId, "claim_account_created_server", entityType, entitySlug);
}

/** A verification method was attempted (email-match routed, or evidence filed). */
export async function trackClaimVerificationAttemptedServer({
  clientId,
  entityType,
  entitySlug,
  method,
}: ClaimEventArgs & { method: ClaimMethod }): Promise<void> {
  if (isSmokeTestEntityId(entitySlug)) return;
  await fireClaimEvent(clientId, "claim_verification_attempted_server", entityType, entitySlug, {
    method,
  });
}

/** Claim approved — ownership granted (the funnel's terminal conversion). */
export async function trackClaimCompletedServer({
  clientId,
  entityType,
  entitySlug,
  method,
}: ClaimEventArgs & { method: ClaimMethod }): Promise<void> {
  if (isSmokeTestEntityId(entitySlug)) return;
  await fireClaimEvent(clientId, "claim_completed_server", entityType, entitySlug, { method });
}
