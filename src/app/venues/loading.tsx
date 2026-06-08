import { VenueCardSkeletonGrid } from "@/components/skeletons";

export default function VenuesLoading() {
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <div className="h-8 bg-muted rounded w-32 animate-pulse" />
        <div className="mt-2 h-5 bg-muted rounded w-72 animate-pulse" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Filter sidebar skeleton */}
        <aside className="lg:col-span-1">
          <div className="bg-card p-4 rounded-lg border border-border space-y-6 animate-pulse">
            {/* Search */}
            <div>
              <div className="h-4 bg-muted rounded w-12 mb-3" />
              <div className="h-10 bg-muted rounded-lg" />
            </div>
            {/* State filter */}
            <div>
              <div className="h-4 bg-muted rounded w-24 mb-3" />
              <div className="space-y-2 max-h-64 overflow-hidden">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="h-8 bg-muted rounded-lg" />
                ))}
              </div>
            </div>
            {/* Events filter */}
            <div>
              <div className="h-4 bg-muted rounded w-16 mb-3" />
              <div className="h-8 bg-muted rounded-lg" />
            </div>
          </div>
        </aside>

        {/* Cards grid */}
        <main className="lg:col-span-3">
          <VenueCardSkeletonGrid count={6} />
        </main>
      </div>
    </div>
  );
}
