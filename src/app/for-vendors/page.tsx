import { Search, UserCircle, ClipboardList, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Metadata } from "next";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "For Vendors | Meet Me at the Fair",
  description: "Find events, build your profile, and grow your business as a vendor with Meet Me at the Fair.",
};

export default function ForVendorsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          For Vendors
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          Find events, showcase your business, and grow your customer base
        </p>
      </div>

      <div className="prose prose-gray max-w-none mb-12">
        <p className="text-lg text-gray-600 leading-relaxed">
          Meet Me at the Fair connects vendors with the fairs, festivals, and
          community events where their products and services will shine. Browse
          upcoming events, apply to participate, and get discovered by
          event-goers who are eager to find what you offer.
        </p>
        <p className="text-lg text-gray-600 leading-relaxed">
          Build a profile that highlights your business, track the events
          you&apos;ve applied to, and let promoters find you when they&apos;re
          looking for the perfect vendor lineup.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                <Search className="w-6 h-6 text-blue-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Find Events</h2>
            </div>
            <p className="text-gray-600">
              Discover fairs, festivals, and markets that are the perfect fit
              for your products and services.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                <UserCircle className="w-6 h-6 text-green-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Build Your Profile</h2>
            </div>
            <p className="text-gray-600">
              Showcase your business with photos, descriptions, and product
              categories so promoters and attendees can find you.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                <ClipboardList className="w-6 h-6 text-purple-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Apply to Events</h2>
            </div>
            <p className="text-gray-600">
              Submit applications to events you&apos;re interested in and track
              your approval status from your dashboard.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-orange-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Grow Your Business</h2>
            </div>
            <p className="text-gray-600">
              Expand your reach by participating in more events and connecting
              with new customers across the region.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="bg-gray-50 rounded-xl p-8 text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">
          Ready to Find Your Next Event?
        </h2>
        <p className="text-gray-600 mb-6">
          Join Meet Me at the Fair and start connecting with the events and
          customers that will help your business grow.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <a
            href="/login"
            className="inline-flex items-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Get Started
          </a>
          <a
            href="/events"
            className="inline-flex items-center px-6 py-3 bg-white text-gray-700 font-medium rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            Browse Events
          </a>
        </div>
      </div>
    </div>
  );
}
