import { CalendarPlus, Users, Megaphone, BarChart3 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Metadata } from "next";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "For Promoters | Meet Me at the Fair",
  description: "List and manage your events, reach thousands of attendees, and grow your fair or festival with Meet Me at the Fair.",
};

export default function ForPromotersPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          For Promoters
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          List your events, manage vendors, and reach thousands of attendees
        </p>
      </div>

      <div className="prose prose-gray max-w-none mb-12">
        <p className="text-lg text-gray-600 leading-relaxed">
          Meet Me at the Fair gives event promoters the tools to showcase their
          fairs, festivals, and community events to a growing audience of
          enthusiastic attendees. Whether you&apos;re organizing a county fair or
          a craft festival, our platform helps you get the word out.
        </p>
        <p className="text-lg text-gray-600 leading-relaxed">
          Manage vendor applications, share event details, and connect with the
          people who are looking for exactly what you offer — all from one
          easy-to-use dashboard.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                <CalendarPlus className="w-6 h-6 text-blue-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">List Events</h2>
            </div>
            <p className="text-gray-600">
              Create detailed event listings with dates, venues, categories, and
              descriptions to attract the right audience.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                <Users className="w-6 h-6 text-green-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Manage Vendors</h2>
            </div>
            <p className="text-gray-600">
              Review and approve vendor applications, coordinate lineups, and
              build the perfect mix for your event.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                <Megaphone className="w-6 h-6 text-purple-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Reach Attendees</h2>
            </div>
            <p className="text-gray-600">
              Get your event in front of thousands of people actively searching
              for fairs, festivals, and local happenings.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center">
                <BarChart3 className="w-6 h-6 text-orange-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Track Performance</h2>
            </div>
            <p className="text-gray-600">
              Monitor interest in your events and understand your audience to
              make every event better than the last.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="bg-gray-50 rounded-xl p-8 text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">
          Ready to Promote Your Event?
        </h2>
        <p className="text-gray-600 mb-6">
          Join Meet Me at the Fair and start reaching attendees who are looking
          for their next great experience.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <a
            href="/login"
            className="inline-flex items-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Get Started
          </a>
          <a
            href="/contact"
            className="inline-flex items-center px-6 py-3 bg-white text-gray-700 font-medium rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            Learn More
          </a>
        </div>
      </div>
    </div>
  );
}
