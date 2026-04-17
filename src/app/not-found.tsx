import Link from "next/link";
import { Home, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Metadata } from "next";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Page Not Found | Meet Me at the Fair",
};

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <div className="mb-6">
          <span className="text-8xl font-bold text-gray-200">404</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Page Not Found</h1>
        <p className="text-gray-600 mb-8">
          Sorry, we couldn&apos;t find the page you&apos;re looking for. It may have been moved or
          no longer exists.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/">
            <Button className="w-full sm:w-auto">
              <Home className="w-4 h-4 mr-2" aria-hidden="true" />
              Go Home
            </Button>
          </Link>
          <Link href="/events">
            <Button variant="outline" className="w-full sm:w-auto">
              <Calendar className="w-4 h-4 mr-2" aria-hidden="true" />
              Browse Events
            </Button>
          </Link>
        </div>

        <div className="mt-8 pt-8 border-t border-gray-200">
          <p className="text-sm text-gray-500 mb-4">Looking for something specific?</p>
          <div className="flex flex-wrap justify-center gap-4 text-sm">
            <Link href="/venues" className="text-royal hover:text-navy">
              Venues
            </Link>
            <Link href="/vendors" className="text-royal hover:text-navy">
              Vendors
            </Link>
            <Link href="/contact" className="text-royal hover:text-navy">
              Contact Us
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
