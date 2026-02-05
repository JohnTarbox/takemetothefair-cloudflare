import { VendorCardSkeletonList } from "@/components/skeletons";

export default function VendorsLoading() {
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <div className="h-8 bg-gray-200 rounded w-44 animate-pulse" />
        <div className="mt-2 h-5 bg-gray-200 rounded w-80 animate-pulse" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Filter sidebar skeleton */}
        <aside className="lg:col-span-1">
          <div className="bg-white p-4 rounded-lg border border-gray-200 space-y-6 animate-pulse">
            {/* Search */}
            <div>
              <div className="h-4 bg-gray-200 rounded w-12 mb-3" />
              <div className="h-10 bg-gray-200 rounded-lg" />
            </div>
            {/* Type filter */}
            <div>
              <div className="h-4 bg-gray-200 rounded w-24 mb-3" />
              <div className="space-y-2 max-h-64 overflow-hidden">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-8 bg-gray-200 rounded-lg" />
                ))}
              </div>
            </div>
            {/* Events filter */}
            <div>
              <div className="h-4 bg-gray-200 rounded w-16 mb-3" />
              <div className="h-8 bg-gray-200 rounded-lg" />
            </div>
            {/* Favorites filter */}
            <div>
              <div className="h-4 bg-gray-200 rounded w-20 mb-3" />
              <div className="h-8 bg-gray-200 rounded-lg" />
            </div>
          </div>
        </aside>

        {/* Cards list */}
        <main className="lg:col-span-3">
          <VendorCardSkeletonList count={4} />
        </main>
      </div>
    </div>
  );
}
