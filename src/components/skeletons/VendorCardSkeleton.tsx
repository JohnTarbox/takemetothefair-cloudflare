import { Card } from "@/components/ui/card";

export function VendorCardSkeleton() {
  return (
    <Card className="animate-pulse">
      <div className="p-6">
        <div className="flex gap-4">
          {/* Logo placeholder */}
          <div className="w-16 h-16 bg-gray-200 rounded-lg flex-shrink-0" />

          <div className="flex-1 min-w-0 space-y-2">
            {/* Business name + badges */}
            <div className="flex items-center gap-2">
              <div className="h-5 bg-gray-200 rounded w-40" />
              <div className="w-4 h-4 bg-gray-200 rounded-full" />
            </div>

            {/* Type and location */}
            <div className="flex items-center gap-2">
              <div className="h-4 bg-gray-200 rounded w-20" />
              <div className="h-4 bg-gray-200 rounded w-24" />
            </div>

            {/* Description */}
            <div className="space-y-1 pt-1">
              <div className="h-4 bg-gray-200 rounded w-full" />
              <div className="h-4 bg-gray-200 rounded w-4/5" />
            </div>

            {/* Products */}
            <div className="flex gap-1 pt-1">
              <div className="h-5 bg-gray-200 rounded-full w-16" />
              <div className="h-5 bg-gray-200 rounded-full w-14" />
              <div className="h-5 bg-gray-200 rounded-full w-18" />
            </div>
          </div>
        </div>

        {/* Events section */}
        <div className="mt-6 pt-6 border-t border-gray-100">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-4 h-4 bg-gray-200 rounded" />
            <div className="h-4 bg-gray-200 rounded w-32" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="p-3 bg-gray-50 rounded-lg">
                <div className="aspect-video bg-gray-200 rounded-md mb-2" />
                <div className="h-4 bg-gray-200 rounded w-3/4 mb-1" />
                <div className="h-3 bg-gray-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function VendorCardSkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <VendorCardSkeleton key={i} />
      ))}
    </div>
  );
}
