import { Card } from "@/components/ui/card";

export function EventCardSkeleton() {
  return (
    <Card className="h-full animate-pulse">
      {/* Image placeholder */}
      <div className="aspect-video bg-muted" />

      <div className="p-4 space-y-3">
        {/* Title */}
        <div className="h-6 bg-muted rounded w-3/4" />

        {/* Date row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 bg-muted rounded" />
            <div className="h-4 bg-muted rounded w-24" />
          </div>
          <div className="w-6 h-6 bg-muted rounded" />
        </div>

        {/* Location */}
        <div className="flex items-center space-x-2">
          <div className="w-4 h-4 bg-muted rounded" />
          <div className="h-4 bg-muted rounded w-40" />
        </div>

        {/* Price */}
        <div className="flex items-center space-x-2">
          <div className="w-4 h-4 bg-muted rounded" />
          <div className="h-4 bg-muted rounded w-16" />
        </div>

        {/* Categories */}
        <div className="flex gap-1 pt-1">
          <div className="h-5 bg-muted rounded-full w-16" />
          <div className="h-5 bg-muted rounded-full w-20" />
        </div>
      </div>
    </Card>
  );
}

export function EventCardSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: count }).map((_, i) => (
        <EventCardSkeleton key={i} />
      ))}
    </div>
  );
}
