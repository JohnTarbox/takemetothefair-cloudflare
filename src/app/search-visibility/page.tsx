import {
  Search,
  Image as ImageIcon,
  MapPin,
  Calendar,
  DollarSign,
  CheckCircle,
  Star,
  ExternalLink,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Metadata } from "next";
import Link from "next/link";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Search Visibility | Meet Me at the Fair",
  description:
    "Learn how Meet Me at the Fair helps your events, venues, and vendor profiles appear in Google search results with rich event cards and business information.",
};

export default function SearchVisibilityPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Get Found in Google Search
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          When you complete your profile, your events and business can appear
          directly in Google search results
        </p>
      </div>

      <div className="prose prose-gray max-w-none mb-12">
        <p className="text-lg text-gray-600 leading-relaxed">
          Meet Me at the Fair automatically adds structured data to your
          listings. This helps Google understand your content and display it as
          rich results - those helpful cards you see when searching for events,
          businesses, or places.
        </p>
      </div>

      {/* What Are Rich Results */}
      <section className="mb-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">
          What Are Rich Results?
        </h2>
        <div className="bg-gray-50 rounded-xl p-6 mb-6">
          <p className="text-gray-700 mb-4">
            When someone searches for &quot;fairs near me&quot; or &quot;craft
            vendors Maine,&quot; Google may show enhanced results that include:
          </p>
          <ul className="space-y-3">
            <li className="flex items-start gap-3">
              <Calendar
                className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0"
                aria-hidden="true"
              />
              <span className="text-gray-700">
                <strong>Event cards</strong> with dates, location, and ticket
                prices
              </span>
            </li>
            <li className="flex items-start gap-3">
              <MapPin
                className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0"
                aria-hidden="true"
              />
              <span className="text-gray-700">
                <strong>Map listings</strong> showing venue locations
              </span>
            </li>
            <li className="flex items-start gap-3">
              <Star
                className="w-5 h-5 text-orange-600 mt-0.5 flex-shrink-0"
                aria-hidden="true"
              />
              <span className="text-gray-700">
                <strong>Business profiles</strong> with contact info and
                products
              </span>
            </li>
          </ul>
        </div>
        <p className="text-gray-600">
          These rich results stand out from regular search listings and get more
          clicks. The more complete your information, the better your chances of
          appearing this way.
        </p>
      </section>

      {/* How Your Data Helps */}
      <section className="mb-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">
          How Your Data Appears in Search
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <Calendar
                    className="w-5 h-5 text-blue-600"
                    aria-hidden="true"
                  />
                </div>
                <CardTitle>Events</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Event name and dates in search results
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Venue address enables &quot;events near me&quot;
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Ticket prices shown directly in Google
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Event image as thumbnail
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                  <MapPin
                    className="w-5 h-5 text-green-600"
                    aria-hidden="true"
                  />
                </div>
                <CardTitle>Venues</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Location appears on Google Maps
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Address and directions available
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Amenities listed (parking, restrooms)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Contact info for attendees
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                  <Star
                    className="w-5 h-5 text-purple-600"
                    aria-hidden="true"
                  />
                </div>
                <CardTitle>Vendors</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Business name and description
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Products can appear in product searches
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Social links and website connected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Contact info for customers
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center">
                  <Search
                    className="w-5 h-5 text-orange-600"
                    aria-hidden="true"
                  />
                </div>
                <CardTitle>Site-wide</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Breadcrumb navigation in results
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  FAQ answers shown directly
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Sitelinks search box enabled
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  aria-hidden="true"
                />
                <span className="text-gray-700">
                  Lists appear as carousels
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Tips for Better Visibility */}
      <section className="mb-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">
          Tips for Better Search Visibility
        </h2>
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <ImageIcon
                    className="w-5 h-5 text-blue-600"
                    aria-hidden="true"
                  />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">
                    Always Add Images
                  </h3>
                  <p className="text-gray-600 text-sm">
                    Events and vendors with images get significantly more
                    clicks. Use high-quality images at least 720 pixels wide
                    with a 16:9 aspect ratio for best results.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <MapPin
                    className="w-5 h-5 text-green-600"
                    aria-hidden="true"
                  />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">
                    Complete Your Address
                  </h3>
                  <p className="text-gray-600 text-sm">
                    Include street address, city, state, and ZIP code. Complete
                    addresses enable &quot;events near me&quot; searches and map
                    integration. Adding GPS coordinates improves accuracy.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <DollarSign
                    className="w-5 h-5 text-purple-600"
                    aria-hidden="true"
                  />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">
                    Set Ticket Prices
                  </h3>
                  <p className="text-gray-600 text-sm">
                    Even if your event is free, set the price to $0. Google
                    displays &quot;Free&quot; in search results, which attracts
                    more attendees. If you have a range, set both minimum and
                    maximum prices.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Star
                    className="w-5 h-5 text-orange-600"
                    aria-hidden="true"
                  />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">
                    List Your Products (Vendors)
                  </h3>
                  <p className="text-gray-600 text-sm">
                    Add specific products you sell (e.g., &quot;Apple Pie,&quot;
                    &quot;Handmade Jewelry,&quot; &quot;Pottery&quot;). These can
                    appear when people search for those products in your area.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <ExternalLink
                    className="w-5 h-5 text-red-600"
                    aria-hidden="true"
                  />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">
                    Add Social Links & Website
                  </h3>
                  <p className="text-gray-600 text-sm">
                    Connect your Facebook, Instagram, and website. Google uses
                    these to verify your business and may display them in search
                    results.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Test Your Listing */}
      <section className="mb-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">
          Test Your Listing
        </h2>
        <Card>
          <CardContent className="p-6">
            <p className="text-gray-700 mb-4">
              Want to see how Google reads your listing? Use Google&apos;s free
              Rich Results Test tool:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-gray-600 mb-4">
              <li>Copy the URL of your event, venue, or vendor page</li>
              <li>
                Paste it into the{" "}
                <a
                  href="https://search.google.com/test/rich-results"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-700 underline"
                >
                  Rich Results Test
                </a>
              </li>
              <li>See exactly what information Google can extract</li>
            </ol>
            <p className="text-sm text-gray-500">
              If anything is missing, update your profile to include that
              information.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* CTA */}
      <div className="bg-gray-50 rounded-xl p-8 text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">
          Ready to Improve Your Visibility?
        </h2>
        <p className="text-gray-600 mb-6">
          Update your profile with complete information to maximize your chances
          of appearing in Google search results.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <Link
            href="/vendor/profile"
            className="inline-flex items-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Update Vendor Profile
          </Link>
          <Link
            href="/promoter/events"
            className="inline-flex items-center px-6 py-3 bg-white text-gray-700 font-medium rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            Manage Events
          </Link>
        </div>
      </div>
    </div>
  );
}
