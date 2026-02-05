import { Card } from "@/components/ui/card";

export function VenueCardSkeleton() {
  return (
    <Card className="h-full animate-pulse">
      {/* Image placeholder */}
      <div className="aspect-video bg-gray-200" />

      <div className="p-4 space-y-3">
        {/* Title */}
        <div className="h-6 bg-gray-200 rounded w-2/3" />

        {/* Address lines */}
        <div className="space-y-2">
          <div className="flex items-start space-x-2">
            <div className="w-4 h-4 bg-gray-200 rounded mt-0.5" />
            <div className="space-y-1 flex-1">
              <div className="h-4 bg-gray-200 rounded w-full" />
              <div className="h-4 bg-gray-200 rounded w-3/4" />
            </div>
          </div>
        </div>

        {/* Capacity */}
        <div className="flex items-center space-x-2">
          <div className="w-4 h-4 bg-gray-200 rounded" />
          <div className="h-4 bg-gray-200 rounded w-28" />
        </div>

        {/* Events count */}
        <div className="flex items-center space-x-2">
          <div className="w-4 h-4 bg-gray-200 rounded" />
          <div className="h-4 bg-gray-200 rounded w-32" />
        </div>

        {/* Amenities */}
        <div className="flex gap-1 pt-1">
          <div className="h-5 bg-gray-200 rounded-full w-14" />
          <div className="h-5 bg-gray-200 rounded-full w-18" />
          <div className="h-5 bg-gray-200 rounded-full w-12" />
        </div>
      </div>
    </Card>
  );
}

export function VenueCardSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: count }).map((_, i) => (
        <VenueCardSkeleton key={i} />
      ))}
    </div>
  );
}
