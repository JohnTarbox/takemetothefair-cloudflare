import Link from "next/link";
import { Home, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * OPE-790 rework — what a page shows when its data source had a platform blip
 * that survived the retry. Rendered INSIDE the normal layout, so the header,
 * nav and footer stay and the reader can go elsewhere. Says plainly that this
 * is a temporary problem on our side, never an empty result.
 */
export function DegradedPanel({ what, retryHref }: { what: string; retryHref: string }) {
  return (
    <div className="min-h-[50vh] flex items-center justify-center px-4" role="status">
      <div className="text-center max-w-md">
        <h1 className="text-2xl font-bold text-foreground mb-2">
          We&rsquo;re having trouble loading {what} right now
        </h1>
        <p className="text-muted-foreground mb-8">
          This is a temporary problem on our side, and it usually clears in a few seconds. Please
          try again in a moment.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href={retryHref}>
            <Button className="w-full sm:w-auto">
              <RotateCw className="w-4 h-4 mr-2" aria-hidden="true" />
              Try again
            </Button>
          </Link>
          <Link href="/">
            <Button variant="outline" className="w-full sm:w-auto">
              <Home className="w-4 h-4 mr-2" aria-hidden="true" />
              Go Home
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
