"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Store, Search, Grid, List, ArrowLeft, CheckCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const runtime = "edge";

interface Vendor {
  id: string;
  businessName: string;
  slug: string;
  vendorType: string | null;
  logoUrl: string | null;
  description: string | null;
  verified: boolean;
  products: string[];
}

interface EventInfo {
  id: string;
  name: string;
  slug: string;
}

export default function EventVendorsPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [eventInfo, setEventInfo] = useState<EventInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  useEffect(() => {
    fetchVendors();
  }, [slug]);

  const fetchVendors = async () => {
    try {
      const res = await fetch(`/api/events/${slug}/vendors`);
      if (res.ok) {
        const data = await res.json();
        setVendors(data.vendors || []);
        setEventInfo(data.event || null);
      }
    } catch (error) {
      console.error("Failed to fetch vendors:", error);
    } finally {
      setLoading(false);
    }
  };

  // Get unique vendor types for filter
  const vendorTypes = Array.from(
    new Set(vendors.map((v) => v.vendorType).filter(Boolean))
  ) as string[];

  // Filter vendors
  const filteredVendors = vendors.filter((vendor) => {
    const matchesSearch =
      vendor.businessName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      vendor.vendorType?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      vendor.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType =
      selectedType === "all" || vendor.vendorType === selectedType;
    return matchesSearch && matchesType;
  });

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-12 bg-gray-200 rounded"></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-48 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <Link
          href={`/events/${slug}`}
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-blue-600 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Event
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">
          Vendors at {eventInfo?.name || "Event"}
        </h1>
        <p className="mt-2 text-gray-600">
          {vendors.length} vendor{vendors.length !== 1 ? "s" : ""} participating
        </p>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search vendors..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="all">All Types</option>
          {vendorTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <div className="flex gap-1 border border-gray-300 rounded-lg p-1">
          <button
            onClick={() => setViewMode("grid")}
            className={`p-2 rounded ${
              viewMode === "grid"
                ? "bg-blue-100 text-blue-600"
                : "text-gray-600 hover:bg-gray-100"
            }`}
            aria-label="Grid view"
          >
            <Grid className="w-5 h-5" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`p-2 rounded ${
              viewMode === "list"
                ? "bg-blue-100 text-blue-600"
                : "text-gray-600 hover:bg-gray-100"
            }`}
            aria-label="List view"
          >
            <List className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Results */}
      {filteredVendors.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Store className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900">
              No vendors found
            </h3>
            <p className="mt-1 text-gray-500">
              Try adjusting your search or filter criteria
            </p>
          </CardContent>
        </Card>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredVendors.map((vendor) => (
            <Link key={vendor.id} href={`/vendors/${vendor.slug}`}>
              <Card className="h-full hover:shadow-lg transition-shadow">
                <CardContent className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                      {vendor.logoUrl ? (
                        <img
                          src={vendor.logoUrl}
                          alt={vendor.businessName}
                          className="w-16 h-16 rounded-lg object-cover"
                        />
                      ) : (
                        <Store className="w-8 h-8 text-gray-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-gray-900 truncate">
                          {vendor.businessName}
                        </h3>
                        {vendor.verified && (
                          <CheckCircle className="w-4 h-4 text-blue-600 flex-shrink-0" />
                        )}
                      </div>
                      {vendor.vendorType && (
                        <Badge variant="default" className="mt-1">
                          {vendor.vendorType}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {vendor.description && (
                    <p className="mt-3 text-sm text-gray-600 line-clamp-2">
                      {vendor.description}
                    </p>
                  )}
                  {vendor.products && vendor.products.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {vendor.products.slice(0, 3).map((product) => (
                        <span
                          key={product}
                          className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded"
                        >
                          {product}
                        </span>
                      ))}
                      {vendor.products.length > 3 && (
                        <span className="px-2 py-0.5 text-gray-500 text-xs">
                          +{vendor.products.length - 3} more
                        </span>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredVendors.map((vendor) => (
            <Link key={vendor.id} href={`/vendors/${vendor.slug}`}>
              <Card className="hover:shadow-md transition-shadow">
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                    {vendor.logoUrl ? (
                      <img
                        src={vendor.logoUrl}
                        alt={vendor.businessName}
                        className="w-16 h-16 rounded-lg object-cover"
                      />
                    ) : (
                      <Store className="w-8 h-8 text-gray-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">
                        {vendor.businessName}
                      </h3>
                      {vendor.verified && (
                        <CheckCircle className="w-4 h-4 text-blue-600" />
                      )}
                      {vendor.vendorType && (
                        <Badge variant="default">{vendor.vendorType}</Badge>
                      )}
                    </div>
                    {vendor.description && (
                      <p className="mt-1 text-sm text-gray-600 line-clamp-1">
                        {vendor.description}
                      </p>
                    )}
                    {vendor.products && vendor.products.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {vendor.products.slice(0, 5).map((product) => (
                          <span
                            key={product}
                            className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded"
                          >
                            {product}
                          </span>
                        ))}
                        {vendor.products.length > 5 && (
                          <span className="px-2 py-0.5 text-gray-500 text-xs">
                            +{vendor.products.length - 5} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
