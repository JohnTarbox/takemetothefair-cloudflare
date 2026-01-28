import Link from "next/link";
import { Home, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <div className="mb-6">
          <span className="text-8xl font-bold text-gray-200">404</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          Page Not Found
        </h1>
        <p className="text-gray-600 mb-8">
          Sorry, we couldn&apos;t find the page you&apos;re looking for.
          It may have been moved or no longer exists.
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
            <Link href="/venues" className="text-blue-600 hover:text-blue-700">
              Venues
            </Link>
            <Link href="/vendors" className="text-blue-600 hover:text-blue-700">
              Vendors
            </Link>
            <Link href="/contact" className="text-blue-600 hover:text-blue-700">
              Contact Us
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
