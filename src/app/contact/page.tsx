import { Mail, MessageSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Metadata } from "next";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Contact Us | Meet Me at the Fair",
  description: "Get in touch with the Meet Me at the Fair team. We're here to help with questions about events, vendor applications, and more.",
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Contact Us
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          Have questions? We&apos;d love to hear from you.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <Mail className="w-5 h-5 text-blue-600" aria-hidden="true" />
              </div>
              <CardTitle>Email Us</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-gray-600 mb-4">
              For general inquiries, support, or feedback:
            </p>
            <a
              href="mailto:hello@meetmeatthefair.com"
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              hello@meetmeatthefair.com
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-green-600" aria-hidden="true" />
              </div>
              <CardTitle>Support</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-gray-600 mb-4">
              Need help with your account or listing?
            </p>
            <a
              href="mailto:support@meetmeatthefair.com"
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              support@meetmeatthefair.com
            </a>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-12">
        <CardHeader>
          <CardTitle>Frequently Asked Questions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">
              How do I list my event?
            </h3>
            <p className="text-gray-600">
              Event promoters can create an account and submit events for approval.
              Once approved, your event will appear in our calendar and search results.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">
              How can I become a vendor at an event?
            </h3>
            <p className="text-gray-600">
              Create a vendor profile, browse available events, and submit applications
              to the events you&apos;re interested in. Event promoters will review and
              respond to your application.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">
              Is it free to list events?
            </h3>
            <p className="text-gray-600">
              Basic event listings are free. Contact us for information about
              featured listings and promotional opportunities.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">
              How do I report an issue with an event listing?
            </h3>
            <p className="text-gray-600">
              If you notice incorrect information or have concerns about a listing,
              please email us at support@meetmeatthefair.com with details.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="bg-gray-50 rounded-xl p-8 text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">
          Partnership Opportunities
        </h2>
        <p className="text-gray-600 mb-6">
          Interested in partnering with Meet Me at the Fair? We&apos;re always
          looking for ways to better serve our community.
        </p>
        <a
          href="mailto:partnerships@meetmeatthefair.com"
          className="inline-flex items-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          Get in Touch
        </a>
      </div>
    </div>
  );
}
