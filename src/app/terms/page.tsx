import type { Metadata } from "next";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Terms of Service | Meet Me at the Fair",
  description: "Terms of service for Meet Me at the Fair - rules and guidelines for using our platform.",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-4xl font-bold text-gray-900 mb-8">
        Terms of Service
      </h1>

      <div className="prose prose-gray max-w-none">
        <p className="text-gray-600 mb-6">
          <strong>Last updated:</strong> January 2026
        </p>

        <p className="text-gray-600 mb-6">
          Welcome to Meet Me at the Fair. By accessing or using our website, you agree
          to be bound by these Terms of Service. Please read them carefully.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          1. Acceptance of Terms
        </h2>
        <p className="text-gray-600 mb-6">
          By accessing and using Meet Me at the Fair, you accept and agree to be bound
          by these Terms of Service and our Privacy Policy. If you do not agree to these
          terms, please do not use our services.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          2. Use of Services
        </h2>
        <p className="text-gray-600 mb-4">
          You agree to use our services only for lawful purposes and in accordance with
          these Terms. You agree not to:
        </p>
        <ul className="list-disc pl-6 text-gray-600 mb-6 space-y-2">
          <li>Submit false, misleading, or fraudulent information</li>
          <li>Impersonate any person or entity</li>
          <li>Interfere with or disrupt our services</li>
          <li>Attempt to gain unauthorized access to our systems</li>
          <li>Use our services for any illegal activity</li>
          <li>Harvest or collect user information without consent</li>
        </ul>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          3. User Accounts
        </h2>
        <p className="text-gray-600 mb-6">
          When you create an account, you are responsible for maintaining the
          confidentiality of your login credentials and for all activities under
          your account. You must notify us immediately of any unauthorized use.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          4. Event Listings
        </h2>
        <p className="text-gray-600 mb-4">
          If you submit event listings, you represent and warrant that:
        </p>
        <ul className="list-disc pl-6 text-gray-600 mb-6 space-y-2">
          <li>You have the right to list the event</li>
          <li>All information provided is accurate and complete</li>
          <li>The event complies with all applicable laws and regulations</li>
          <li>You will update or remove listings that are no longer accurate</li>
        </ul>
        <p className="text-gray-600 mb-6">
          We reserve the right to remove any listing that violates these terms or
          that we determine, in our sole discretion, is inappropriate.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          5. Vendor Profiles
        </h2>
        <p className="text-gray-600 mb-6">
          Vendors who create profiles agree to provide accurate business information
          and to conduct themselves professionally when interacting with event promoters
          and attendees. We are not responsible for disputes between vendors and promoters.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          6. Intellectual Property
        </h2>
        <p className="text-gray-600 mb-6">
          The content, features, and functionality of our website are owned by
          Meet Me at the Fair and are protected by copyright, trademark, and other
          intellectual property laws. You may not copy, modify, or distribute our
          content without permission.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          7. User Content
        </h2>
        <p className="text-gray-600 mb-6">
          By submitting content to our website (including event listings, vendor
          profiles, and images), you grant us a non-exclusive, royalty-free license
          to use, display, and distribute that content in connection with our services.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          8. Disclaimer of Warranties
        </h2>
        <p className="text-gray-600 mb-6">
          Our services are provided &quot;as is&quot; without warranties of any kind. We do not
          guarantee the accuracy of event listings or vendor information. We are not
          responsible for the quality, safety, or legality of events listed on our platform.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          9. Limitation of Liability
        </h2>
        <p className="text-gray-600 mb-6">
          To the maximum extent permitted by law, Meet Me at the Fair shall not be
          liable for any indirect, incidental, special, consequential, or punitive
          damages arising from your use of our services.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          10. Indemnification
        </h2>
        <p className="text-gray-600 mb-6">
          You agree to indemnify and hold harmless Meet Me at the Fair from any claims,
          damages, or expenses arising from your use of our services or violation of
          these Terms.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          11. Termination
        </h2>
        <p className="text-gray-600 mb-6">
          We may terminate or suspend your account at any time for any reason,
          including violation of these Terms. Upon termination, your right to use
          our services will immediately cease.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          12. Changes to Terms
        </h2>
        <p className="text-gray-600 mb-6">
          We reserve the right to modify these Terms at any time. We will notify
          users of significant changes by posting a notice on our website. Continued
          use of our services after changes constitutes acceptance of the new Terms.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          13. Governing Law
        </h2>
        <p className="text-gray-600 mb-6">
          These Terms shall be governed by and construed in accordance with the laws
          of the United States, without regard to conflict of law principles.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          14. Contact Information
        </h2>
        <p className="text-gray-600 mb-6">
          If you have questions about these Terms, please contact us at:
        </p>
        <p className="text-gray-600">
          <a href="mailto:legal@meetmeatthefair.com" className="text-blue-600 hover:text-blue-700">
            legal@meetmeatthefair.com
          </a>
        </p>
      </div>
    </div>
  );
}
