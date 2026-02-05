import { EventCardSkeletonGrid } from "@/components/skeletons";

export default function EventsLoading() {
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <div className="h-8 bg-gray-200 rounded w-48 animate-pulse" />
        <div className="mt-2 h-5 bg-gray-200 rounded w-80 animate-pulse" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Filter sidebar skeleton */}
        <aside className="lg:col-span-1">
          <div className="bg-white p-4 rounded-lg border border-gray-200 space-y-4 animate-pulse">
            {/* Search */}
            <div className="h-10 bg-gray-200 rounded-lg" />
            {/* Category dropdown */}
            <div className="space-y-1">
              <div className="h-4 bg-gray-200 rounded w-16" />
              <div className="h-10 bg-gray-200 rounded-lg" />
            </div>
            {/* State dropdown */}
            <div className="space-y-1">
              <div className="h-4 bg-gray-200 rounded w-12" />
              <div className="h-10 bg-gray-200 rounded-lg" />
            </div>
            {/* Checkboxes */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 bg-gray-200 rounded" />
                <div className="h-4 bg-gray-200 rounded w-24" />
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 bg-gray-200 rounded" />
                <div className="h-4 bg-gray-200 rounded w-36" />
              </div>
            </div>
            {/* Buttons */}
            <div className="flex gap-2">
              <div className="flex-1 h-10 bg-gray-200 rounded-lg" />
              <div className="h-10 w-16 bg-gray-200 rounded-lg" />
            </div>
          </div>
        </aside>

        {/* Cards grid */}
        <main className="lg:col-span-3">
          <EventCardSkeletonGrid count={6} />
        </main>
      </div>
    </div>
  );
}
