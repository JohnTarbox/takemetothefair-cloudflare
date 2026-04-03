import type { Metadata } from "next";
import { WebPageSchema } from "@/components/seo/WebPageSchema";

export const runtime = "edge";
export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Privacy Policy | Meet Me at the Fair",
  description: "Privacy policy for Meet Me at the Fair - how we collect, use, and protect your personal information.",
  alternates: { canonical: "https://meetmeatthefair.com/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <WebPageSchema
        name="Privacy Policy | Meet Me at the Fair"
        description="Privacy policy for Meet Me at the Fair - how we collect, use, and protect your personal information."
        url="https://meetmeatthefair.com/privacy"
      />
      <h1 className="text-4xl font-bold text-gray-900 mb-8">
        Privacy Policy
      </h1>

      <div className="prose prose-gray max-w-none">
        <p className="text-gray-600 mb-6">
          <strong>Last updated:</strong> April 2026
        </p>

        <p className="text-gray-600 mb-6">
          Meet Me at the Fair (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) is committed to protecting
          your privacy. This Privacy Policy explains how we collect, use, disclose,
          and safeguard your information when you visit our website.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Information We Collect
        </h2>

        <h3 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
          Personal Information
        </h3>
        <p className="text-gray-600 mb-4">
          We may collect personal information that you voluntarily provide when you:
        </p>
        <ul className="list-disc pl-6 text-gray-600 mb-6 space-y-2">
          <li>Create an account</li>
          <li>Submit an event listing</li>
          <li>Create a vendor profile</li>
          <li>Contact us through our website</li>
          <li>Subscribe to our newsletter</li>
        </ul>
        <p className="text-gray-600 mb-6">
          This information may include your name, email address, phone number,
          business name, and other details you choose to provide.
        </p>

        <h3 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
          Automatically Collected Information
        </h3>
        <p className="text-gray-600 mb-6">
          When you visit our website, we may automatically collect certain information
          including your IP address, browser type, device information, and pages visited.
          This helps us improve our services and user experience.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          How We Use Your Information
        </h2>
        <p className="text-gray-600 mb-4">
          We use the information we collect to:
        </p>
        <ul className="list-disc pl-6 text-gray-600 mb-6 space-y-2">
          <li>Provide and maintain our services</li>
          <li>Process event listings and vendor applications</li>
          <li>Send you updates about events you&apos;ve shown interest in</li>
          <li>Respond to your inquiries and support requests</li>
          <li>Improve our website and services</li>
          <li>Protect against fraudulent or unauthorized activity</li>
        </ul>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Information Sharing
        </h2>
        <p className="text-gray-600 mb-6">
          We do not sell your personal information. We may share your information with:
        </p>
        <ul className="list-disc pl-6 text-gray-600 mb-6 space-y-2">
          <li>Event promoters (for vendor applications)</li>
          <li>Service providers who assist in operating our website</li>
          <li>Law enforcement when required by law</li>
        </ul>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Data Security
        </h2>
        <p className="text-gray-600 mb-6">
          We implement appropriate security measures to protect your personal information.
          However, no method of transmission over the internet is 100% secure, and we
          cannot guarantee absolute security.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Data Retention
        </h2>
        <p className="text-gray-600 mb-6">
          We retain your personal information for as long as your account is active
          or as needed to provide our services. If you request account deletion, we
          will remove your personal data within 30 days of your request. Anonymized
          data (such as aggregate statistics) may be retained indefinitely.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Third-Party Services
        </h2>
        <p className="text-gray-600 mb-4">
          We use the following third-party services to operate our website:
        </p>
        <ul className="list-disc pl-6 text-gray-600 mb-6 space-y-2">
          <li><strong>Cloudflare</strong> — hosting, CDN, and security services</li>
          <li><strong>Google Analytics</strong> — website usage analytics</li>
          <li><strong>Google OAuth</strong> — optional social login</li>
          <li><strong>Facebook OAuth</strong> — optional social login</li>
          <li><strong>Google Places API</strong> — venue location data and mapping</li>
          <li><strong>Cloudflare Workers AI</strong> — event data extraction from submitted URLs</li>
        </ul>
        <p className="text-gray-600 mb-6">
          Each service has its own privacy policy governing how they handle your data.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Data Breach Notification
        </h2>
        <p className="text-gray-600 mb-6">
          In the event of a data breach that may affect your personal information,
          we will notify affected users within 72 hours of discovering the breach
          via email and/or a notice on our website.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Your Rights
        </h2>
        <p className="text-gray-600 mb-4">
          You have the right to:
        </p>
        <ul className="list-disc pl-6 text-gray-600 mb-6 space-y-2">
          <li>Access the personal information we hold about you</li>
          <li>Request correction of inaccurate information</li>
          <li>Request deletion of your account and data</li>
          <li>Opt out of marketing communications</li>
          <li>Request a copy of your data in a portable format</li>
        </ul>
        <p className="text-gray-600 mb-6">
          To exercise any of these rights, please contact us at{" "}
          <a href="mailto:privacy@meetmeatthefair.com" className="text-royal hover:text-navy">
            privacy@meetmeatthefair.com
          </a>.
          We will respond to your request within 30 days.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Cookies
        </h2>
        <p className="text-gray-600 mb-6">
          We use cookies and similar technologies to enhance your experience,
          analyze usage patterns, and remember your preferences. You can control
          cookie settings through your browser.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Children&apos;s Privacy
        </h2>
        <p className="text-gray-600 mb-6">
          Our website is not intended for children under 13 years of age. We do not
          knowingly collect personal information from children under 13.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Changes to This Policy
        </h2>
        <p className="text-gray-600 mb-6">
          We may update this Privacy Policy from time to time. We will notify you
          of any changes by posting the new policy on this page and updating the
          &quot;Last updated&quot; date.
        </p>

        <h2 className="text-2xl font-bold text-gray-900 mt-8 mb-4">
          Contact Us
        </h2>
        <p className="text-gray-600 mb-6">
          If you have questions about this Privacy Policy, please contact us at:
        </p>
        <p className="text-gray-600">
          <a href="mailto:privacy@meetmeatthefair.com" className="text-royal hover:text-navy">
            privacy@meetmeatthefair.com
          </a>
        </p>
      </div>
    </div>
  );
}
