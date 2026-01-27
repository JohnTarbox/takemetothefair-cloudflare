"use client";

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, ArrowRight, Check, GitMerge, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type {
  DuplicateEntityType,
  DuplicatePair,
  MergePreviewResponse,
  FindDuplicatesResponse,
} from "@/lib/duplicates/types";

const ENTITY_TYPES: { value: DuplicateEntityType; label: string }[] = [
  { value: "venues", label: "Venues" },
  { value: "events", label: "Events" },
  { value: "vendors", label: "Vendors" },
  { value: "promoters", label: "Promoters" },
];

const THRESHOLDS = [
  { value: 0.6, label: "60% (More matches)" },
  { value: 0.7, label: "70% (Default)" },
  { value: 0.8, label: "80% (Stricter)" },
  { value: 0.9, label: "90% (Very strict)" },
];

// Helper to get display name based on entity type
function getDisplayName(
  entity: Record<string, unknown>,
  type: DuplicateEntityType
): string {
  switch (type) {
    case "vendors":
      return entity.businessName as string;
    case "promoters":
      return entity.companyName as string;
    default:
      return entity.name as string;
  }
}

// Helper to get entity count label
function getCountLabel(
  entity: Record<string, unknown>,
  type: DuplicateEntityType
): string {
  const count = entity._count as Record<string, number>;
  switch (type) {
    case "venues":
      return `${count?.events || 0} events`;
    case "events":
      return `${count?.eventVendors || 0} vendors`;
    case "vendors":
      return `${count?.eventVendors || 0} events`;
    case "promoters":
      return `${count?.events || 0} events`;
  }
}

// Helper to format similarity as percentage
function formatSimilarity(similarity: number): string {
  return `${Math.round(similarity * 100)}%`;
}

export default function AdminDuplicatesPage() {
  const [entityType, setEntityType] = useState<DuplicateEntityType>("venues");
  const [threshold, setThreshold] = useState(0.7);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [totalEntities, setTotalEntities] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Review modal state
  const [selectedPair, setSelectedPair] = useState<DuplicatePair | null>(null);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [preview, setPreview] = useState<MergePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeSuccess, setMergeSuccess] = useState(false);

  const fetchDuplicates = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/admin/duplicates?type=${entityType}&threshold=${threshold}`
      );
      if (!res.ok) {
        throw new Error("Failed to fetch duplicates");
      }
      const data: FindDuplicatesResponse = await res.json();
      setDuplicates(data.duplicates);
      setTotalEntities(data.totalEntities);
    } catch (err) {
      console.error("Failed to fetch duplicates:", err);
      setError("Failed to fetch duplicates. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [entityType, threshold]);

  useEffect(() => {
    fetchDuplicates();
  }, [fetchDuplicates]);

  const handleReview = (pair: DuplicatePair) => {
    setSelectedPair(pair);
    setPrimaryId(null);
    setPreview(null);
    setMergeSuccess(false);
  };

  const handleCloseReview = () => {
    setSelectedPair(null);
    setPrimaryId(null);
    setPreview(null);
    setMergeSuccess(false);
  };

  const handlePreview = async () => {
    if (!selectedPair || !primaryId) return;

    const duplicateId =
      primaryId === (selectedPair.entity1 as Record<string, unknown>).id
        ? (selectedPair.entity2 as Record<string, unknown>).id
        : (selectedPair.entity1 as Record<string, unknown>).id;

    setPreviewLoading(true);

    try {
      const res = await fetch("/api/admin/duplicates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: entityType,
          primaryId,
          duplicateId,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to generate preview");
      }

      const data: MergePreviewResponse = await res.json();
      setPreview(data);
    } catch (err) {
      console.error("Failed to generate preview:", err);
      setError("Failed to generate merge preview. Please try again.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleMerge = async () => {
    if (!preview || !primaryId || !selectedPair) return;

    const duplicateId =
      primaryId === (selectedPair.entity1 as Record<string, unknown>).id
        ? (selectedPair.entity2 as Record<string, unknown>).id
        : (selectedPair.entity1 as Record<string, unknown>).id;

    if (
      !confirm(
        `Are you sure you want to merge these ${entityType.slice(0, -1)} records? This action cannot be undone.`
      )
    ) {
      return;
    }

    setMerging(true);

    try {
      const res = await fetch("/api/admin/duplicates/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: entityType,
          primaryId,
          duplicateId,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to merge");
      }

      setMergeSuccess(true);

      // Refresh the duplicates list after a short delay
      setTimeout(() => {
        handleCloseReview();
        fetchDuplicates();
      }, 1500);
    } catch (err) {
      console.error("Failed to merge:", err);
      setError("Failed to merge records. Please try again.");
    } finally {
      setMerging(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Find &amp; Merge Duplicates
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Review and merge duplicate records to keep your data clean
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-4">
            {/* Entity Type Tabs */}
            <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
              {ENTITY_TYPES.map((type) => (
                <button
                  key={type.value}
                  onClick={() => setEntityType(type.value)}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    entityType === type.value
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {type.label}
                </button>
              ))}
            </div>

            {/* Threshold Select */}
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600">Similarity:</label>
              <select
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value))}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {THRESHOLDS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={fetchDuplicates}
              isLoading={loading}
            >
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error Message */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 text-red-500 hover:text-red-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Results */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              {loading
                ? "Searching..."
                : `Found ${duplicates.length} potential duplicate pairs from ${totalEntities} ${entityType}`}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="animate-pulse space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-24 bg-gray-100 rounded-lg"></div>
              ))}
            </div>
          ) : duplicates.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <GitMerge className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No duplicates found at {formatSimilarity(threshold)} threshold</p>
              <p className="text-sm mt-2">
                Try lowering the similarity threshold to find more matches
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {duplicates.map((pair) => {
                const entity1 = pair.entity1 as Record<string, unknown>;
                const entity2 = pair.entity2 as Record<string, unknown>;

                return (
                  <div
                    key={`${entity1.id}-${entity2.id}`}
                    className="border border-gray-200 rounded-lg p-4 hover:border-gray-300 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 flex-1">
                        {/* Entity 1 */}
                        <div className="flex-1">
                          <p className="font-medium text-gray-900">
                            {getDisplayName(entity1, entityType)}
                          </p>
                          <p className="text-sm text-gray-500">
                            {getCountLabel(entity1, entityType)}
                          </p>
                        </div>

                        {/* Similarity Badge */}
                        <div className="flex flex-col items-center">
                          <Badge
                            variant={
                              pair.similarity >= 0.9
                                ? "danger"
                                : pair.similarity >= 0.8
                                  ? "warning"
                                  : "info"
                            }
                          >
                            {formatSimilarity(pair.similarity)}
                          </Badge>
                          <ArrowRight className="w-4 h-4 text-gray-400 my-1" />
                        </div>

                        {/* Entity 2 */}
                        <div className="flex-1">
                          <p className="font-medium text-gray-900">
                            {getDisplayName(entity2, entityType)}
                          </p>
                          <p className="text-sm text-gray-500">
                            {getCountLabel(entity2, entityType)}
                          </p>
                        </div>
                      </div>

                      {/* Review Button */}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleReview(pair)}
                      >
                        Review
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Review Modal */}
      {selectedPair && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={handleCloseReview}
          ></div>
          <div className="relative bg-white rounded-xl shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold text-gray-900">
                Review Duplicate {entityType.slice(0, -1)}
              </h2>
              <button
                onClick={handleCloseReview}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-140px)]">
              {mergeSuccess ? (
                <div className="text-center py-12">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Check className="w-8 h-8 text-green-600" />
                  </div>
                  <h3 className="text-lg font-medium text-gray-900">
                    Merge Successful!
                  </h3>
                  <p className="text-gray-600 mt-2">
                    The records have been merged successfully.
                  </p>
                </div>
              ) : (
                <>
                  {/* Side by Side Comparison */}
                  <div className="mb-6">
                    <h3 className="text-sm font-medium text-gray-700 mb-3">
                      Select the primary record to keep:
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      {[selectedPair.entity1, selectedPair.entity2].map(
                        (entity) => {
                          const e = entity as Record<string, unknown>;
                          const isSelected = primaryId === e.id;
                          const count = e._count as Record<string, number>;

                          return (
                            <button
                              key={e.id as string}
                              onClick={() => {
                                setPrimaryId(e.id as string);
                                setPreview(null);
                              }}
                              className={`text-left p-4 border-2 rounded-lg transition-colors ${
                                isSelected
                                  ? "border-blue-500 bg-blue-50"
                                  : "border-gray-200 hover:border-gray-300"
                              }`}
                            >
                              <div className="flex items-start justify-between">
                                <div>
                                  <p className="font-medium text-gray-900">
                                    {getDisplayName(e, entityType)}
                                  </p>
                                  <p className="text-sm text-gray-500 mt-1">
                                    Slug: {e.slug as string}
                                  </p>
                                </div>
                                {isSelected && (
                                  <Badge variant="success">Primary</Badge>
                                )}
                              </div>

                              <div className="mt-3 space-y-1 text-sm">
                                {entityType === "venues" && (
                                  <>
                                    <p className="text-gray-600">
                                      {e.city as string}, {e.state as string}
                                    </p>
                                    <p className="text-gray-600">
                                      {count?.events || 0} events
                                    </p>
                                  </>
                                )}
                                {entityType === "events" && (
                                  <>
                                    <p className="text-gray-600">
                                      Venue:{" "}
                                      {(e.venue as Record<string, string>)?.name || "N/A"}
                                    </p>
                                    <p className="text-gray-600">
                                      {count?.eventVendors || 0} vendors
                                    </p>
                                    <p className="text-gray-600">
                                      {e.viewCount as number} views
                                    </p>
                                  </>
                                )}
                                {entityType === "vendors" && (
                                  <>
                                    <p className="text-gray-600">
                                      Type: {(e.vendorType as string) || "N/A"}
                                    </p>
                                    <p className="text-gray-600">
                                      {count?.eventVendors || 0} events
                                    </p>
                                  </>
                                )}
                                {entityType === "promoters" && (
                                  <p className="text-gray-600">
                                    {count?.events || 0} events
                                  </p>
                                )}
                              </div>
                            </button>
                          );
                        }
                      )}
                    </div>
                  </div>

                  {/* Preview Button */}
                  {primaryId && !preview && (
                    <div className="mb-6">
                      <Button
                        onClick={handlePreview}
                        isLoading={previewLoading}
                        className="w-full"
                      >
                        Preview Merge
                      </Button>
                    </div>
                  )}

                  {/* Preview Results */}
                  {preview && (
                    <div className="space-y-4">
                      {/* Warnings */}
                      {preview.warnings.length > 0 && (
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                          <div className="flex items-start gap-3">
                            <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                            <div>
                              <p className="font-medium text-yellow-800">
                                Warnings
                              </p>
                              <ul className="mt-1 text-sm text-yellow-700 space-y-1">
                                {preview.warnings.map((warning, i) => (
                                  <li key={i}>{warning}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Transfer Summary */}
                      <div className="bg-gray-50 rounded-lg p-4">
                        <h4 className="font-medium text-gray-900 mb-3">
                          Relationships to Transfer
                        </h4>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          {preview.relationshipsToTransfer.events !==
                            undefined && (
                            <div className="flex justify-between">
                              <span className="text-gray-600">Events:</span>
                              <span className="font-medium">
                                {preview.relationshipsToTransfer.events}
                              </span>
                            </div>
                          )}
                          {preview.relationshipsToTransfer.eventVendors !==
                            undefined && (
                            <div className="flex justify-between">
                              <span className="text-gray-600">
                                Event-Vendor Links:
                              </span>
                              <span className="font-medium">
                                {preview.relationshipsToTransfer.eventVendors}
                              </span>
                            </div>
                          )}
                          {preview.relationshipsToTransfer.favorites !==
                            undefined && (
                            <div className="flex justify-between">
                              <span className="text-gray-600">Favorites:</span>
                              <span className="font-medium">
                                {preview.relationshipsToTransfer.favorites}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Merge Button */}
                      {preview.canMerge && (
                        <Button
                          variant="danger"
                          onClick={handleMerge}
                          isLoading={merging}
                          className="w-full"
                        >
                          <GitMerge className="w-4 h-4 mr-2" />
                          Merge Records
                        </Button>
                      )}

                      {!preview.canMerge && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
                          <p className="text-red-700">
                            These records cannot be merged. Please review the
                            warnings above.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
