import { Suspense } from "react";
import { Search, Filter } from "lucide-react";
import { EventList } from "@/components/events/event-list";
import prisma from "@/lib/prisma";

interface SearchParams {
  query?: string;
  category?: string;
  state?: string;
  featured?: string;
  page?: string;
}

async function getEvents(searchParams: SearchParams) {
  const page = parseInt(searchParams.page || "1");
  const limit = 12;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {
    status: "APPROVED",
    endDate: { gte: new Date() },
  };

  if (searchParams.query) {
    where.OR = [
      { name: { contains: searchParams.query, mode: "insensitive" } },
      { description: { contains: searchParams.query, mode: "insensitive" } },
    ];
  }

  if (searchParams.category) {
    where.categories = { has: searchParams.category };
  }

  if (searchParams.state) {
    where.venue = { state: searchParams.state };
  }

  if (searchParams.featured === "true") {
    where.featured = true;
  }

  try {
    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        include: {
          venue: true,
          promoter: true,
        },
        orderBy: { startDate: "asc" },
        skip,
        take: limit,
      }),
      prisma.event.count({ where }),
    ]);

    return { events, total, page, limit };
  } catch {
    return { events: [], total: 0, page: 1, limit };
  }
}

async function getCategories() {
  try {
    const events = await prisma.event.findMany({
      where: { status: "APPROVED" },
      select: { categories: true },
    });
    const categories = new Set<string>();
    events.forEach((e) => e.categories.forEach((c) => categories.add(c)));
    return Array.from(categories).sort();
  } catch {
    return [];
  }
}

async function getStates() {
  try {
    const venues = await prisma.venue.findMany({
      where: { status: "ACTIVE" },
      select: { state: true },
      distinct: ["state"],
    });
    return venues.map((v) => v.state).sort();
  } catch {
    return [];
  }
}

function EventsFilter({
  categories,
  states,
  searchParams,
}: {
  categories: string[];
  states: string[];
  searchParams: SearchParams;
}) {
  return (
    <form className="bg-white p-4 rounded-lg border border-gray-200 space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Search
        </label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            name="query"
            defaultValue={searchParams.query}
            placeholder="Search events..."
            className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Category
        </label>
        <select
          name="category"
          defaultValue={searchParams.category}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All Categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          State
        </label>
        <select
          name="state"
          defaultValue={searchParams.state}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All States</option>
          {states.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="featured"
          value="true"
          defaultChecked={searchParams.featured === "true"}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">Featured only</span>
      </label>

      <button
        type="submit"
        className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
      >
        <Filter className="w-4 h-4" />
        Apply Filters
      </button>
    </form>
  );
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const [{ events, total, page, limit }, categories, states] =
    await Promise.all([getEvents(params), getCategories(), getStates()]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Browse Events</h1>
        <p className="mt-2 text-gray-600">
          Discover upcoming fairs, festivals, and community events
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <aside className="lg:col-span-1">
          <Suspense fallback={<div className="animate-pulse bg-gray-200 h-64 rounded-lg" />}>
            <EventsFilter
              categories={categories}
              states={states}
              searchParams={params}
            />
          </Suspense>
        </aside>

        <main className="lg:col-span-3">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Showing {events.length} of {total} events
            </p>
          </div>

          <EventList
            events={events}
            emptyMessage="No events match your filters. Try adjusting your search."
          />

          {totalPages > 1 && (
            <div className="mt-8 flex justify-center gap-2">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <a
                  key={p}
                  href={`/events?${new URLSearchParams({
                    ...params,
                    page: p.toString(),
                  } as Record<string, string>).toString()}`}
                  className={`px-4 py-2 rounded-lg ${
                    p === page
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {p}
                </a>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
