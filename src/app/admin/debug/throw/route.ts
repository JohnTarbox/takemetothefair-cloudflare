export const dynamic = "force-dynamic";
import { requireAdminAuth } from "@/lib/api-auth";

// OPE-80 live-verification canary: admin-gated route that ALWAYS throws so an
// operator can confirm a source='server-render' error_logs row lands with the
// real message + digest + route on Workers (onRequestError → captureServerRenderError).
//
// It is admin-gated so it is not a public DoS surface. The throw must escape
// UNCAUGHT to reach Next's onRequestError — hence the manual gate here rather
// than withAuth(), whose dispatch() catches handler throws (converting them to
// a logged 500) and would prevent onRequestError from ever firing.
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminAuth(request);
  if (denied) return denied;

  throw new Error("OPE-80 canary: server-render capture check");
}
