import { Calendar, Users, MapPin, Heart } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About Us | Meet Me at the Fair",
  description: "Learn about Meet Me at the Fair - your community calendar for fairs, festivals, and local events.",
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          About Meet Me at the Fair
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          Connecting communities through fairs, festivals, and local events
        </p>
      </div>

      <div className="prose prose-gray max-w-none mb-12">
        <p className="text-lg text-gray-600 leading-relaxed">
          Meet Me at the Fair is your go-to destination for discovering amazing fairs,
          festivals, and community events in your area. We believe that local events
          bring people together, support small businesses, and create lasting memories.
        </p>
        <p className="text-lg text-gray-600 leading-relaxed">
          Our platform connects event-goers with the best local happenings, while
          providing promoters and vendors with the tools they need to reach their
          audience and grow their businesses.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                <Calendar className="w-6 h-6 text-blue-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">For Event-Goers</h2>
            </div>
            <p className="text-gray-600">
              Discover upcoming fairs and festivals, explore vendor lineups,
              find venue information, and never miss an event you&apos;ll love.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                <Users className="w-6 h-6 text-green-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">For Promoters</h2>
            </div>
            <p className="text-gray-600">
              List your events, manage vendor applications, and reach thousands
              of potential attendees looking for their next great experience.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                <MapPin className="w-6 h-6 text-purple-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">For Vendors</h2>
            </div>
            <p className="text-gray-600">
              Find events that match your products, apply to participate,
              and grow your customer base at fairs and festivals.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-red-100 rounded-lg flex items-center justify-center">
                <Heart className="w-6 h-6 text-red-600" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Our Mission</h2>
            </div>
            <p className="text-gray-600">
              To strengthen local communities by making it easy to discover,
              promote, and participate in the events that bring us together.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="bg-gray-50 rounded-xl p-8 text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">
          Join Our Community
        </h2>
        <p className="text-gray-600 mb-6">
          Whether you&apos;re looking for your next adventure or want to share
          your event with the world, we&apos;re here to help.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <a
            href="/events"
            className="inline-flex items-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Browse Events
          </a>
          <a
            href="/contact"
            className="inline-flex items-center px-6 py-3 bg-white text-gray-700 font-medium rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            Contact Us
          </a>
        </div>
      </div>
    </div>
  );
}
