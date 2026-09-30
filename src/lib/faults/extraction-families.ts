/**
 * OPE-463 — re-export shim.
 *
 * The vocabulary lives in `@takemetothefair/constants` because BOTH Workers
 * need it: the MCP Worker enforces the gate on `update_event_status`, and the
 * main app reads the same families when classifying. A copy in each is the
 * split-construction defect OPE-806 just closed.
 *
 * Kept as a shim so main-app code can import it from the `faults/` directory
 * where the rest of this machinery lives.
 */
export {
  EXTRACTION_REJECT_FAMILIES,
  REASON_REQUIRED_INGESTION_METHODS,
  humanRejectSignature,
  rejectReasonRequired,
  type ExtractionRejectFamily,
} from "@takemetothefair/constants";
