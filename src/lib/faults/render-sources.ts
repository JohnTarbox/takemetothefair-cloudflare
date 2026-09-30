/**
 * The error_logs sources that ARE render faults: the browser's error boundary
 * (`client`) and the server-side capture (`server-render`, OPE-80).
 *
 * Moved here from the OPE-81 candidates route (OPE-1161 A2) so the render-fault
 * rail and the dashboard's server-message share cannot disagree about what a
 * render error is. A route file may only export its handlers, so the constant
 * could not be shared from there.
 */
export const RENDER_FAULT_SOURCES: readonly string[] = ["server-render", "client"];
