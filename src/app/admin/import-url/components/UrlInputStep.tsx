import Link from "next/link";
import { Link2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface UrlInputStepProps {
  url: string;
  manualPaste: boolean;
  pastedContent: string;
  duplicateWarning: { name: string; slug: string } | null;
  onUrlChange: (url: string) => void;
  onManualPasteChange: (enabled: boolean) => void;
  onPastedContentChange: (content: string) => void;
  onFetch: () => void;
}

export function UrlInputStep({
  url,
  manualPaste,
  pastedContent,
  duplicateWarning,
  onUrlChange,
  onManualPasteChange,
  onPastedContentChange,
  onFetch,
}: UrlInputStepProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="w-5 h-5" />
          Enter Event URL
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {duplicateWarning && (
          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
            <div className="text-yellow-800">
              This URL was already imported as{" "}
              <Link
                href={`/events/${duplicateWarning.slug}`}
                target="_blank"
                className="font-medium underline hover:text-yellow-900"
              >
                {duplicateWarning.name}
              </Link>
              . You can still import it again if needed.
            </div>
          </div>
        )}
        {!manualPaste ? (
          <>
            <div>
              <Label htmlFor="url">Event Page URL</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  id="url"
                  type="url"
                  placeholder="https://example.com/event-page"
                  value={url}
                  onChange={(e) => onUrlChange(e.target.value)}
                  className="flex-1"
                />
                <Button onClick={onFetch} disabled={!url}>
                  Fetch Page
                </Button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={manualPaste}
                onChange={(e) => onManualPasteChange(e.target.checked)}
                className="rounded border-gray-300"
              />
              I can&apos;t fetch the page - let me paste content
            </label>
          </>
        ) : (
          <>
            <div>
              <Label htmlFor="pastedContent">Paste Page Content</Label>
              <textarea
                id="pastedContent"
                className="mt-1 w-full h-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="Paste the event page content here..."
                value={pastedContent}
                onChange={(e) => onPastedContentChange(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="urlManual">Source URL (optional)</Label>
              <Input
                id="urlManual"
                type="url"
                placeholder="https://example.com/event-page"
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
                className="mt-1"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={onFetch} disabled={!pastedContent.trim()}>
                Extract Event Data
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  onManualPasteChange(false);
                  onPastedContentChange("");
                }}
              >
                Back to URL
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
