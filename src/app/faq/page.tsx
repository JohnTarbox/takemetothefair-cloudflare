import {
  HelpCircle,
  Users,
  Store,
  Calendar,
  Settings,
} from "lucide-react";
import type { Metadata } from "next";
import { FAQSchema } from "@/components/seo/FAQSchema";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "FAQ | Meet Me at the Fair",
  description:
    "Find answers to common questions about Meet Me at the Fair - how to find events, become a vendor, list your event, and more.",
};

const faqCategories = [
  {
    title: "Getting Started",
    icon: HelpCircle,
    iconBg: "bg-blue-100",
    iconColor: "text-blue-600",
    items: [
      {
        question: "What is Meet Me at the Fair?",
        answer:
          "Meet Me at the Fair is a platform that connects event attendees, vendors, and promoters. Browse upcoming fairs, festivals, and markets, discover vendors, or list your own events and vendor profiles.",
      },
      {
        question: "Do I need an account to browse events?",
        answer:
          "No, you can browse all public events, venues, and vendors without creating an account. However, an account lets you save favorites, apply as a vendor, and create event listings.",
      },
      {
        question: "How do I create an account?",
        answer:
          "Click 'Sign In' in the top navigation and choose your preferred sign-in method. You can sign up with your email address or use social login options like Google.",
      },
      {
        question: "Is Meet Me at the Fair free to use?",
        answer:
          "Yes, browsing events and creating a basic account is completely free. Vendors and promoters may have access to premium features with additional capabilities.",
      },
    ],
  },
  {
    title: "For Attendees",
    icon: Users,
    iconBg: "bg-green-100",
    iconColor: "text-green-600",
    items: [
      {
        question: "How do I find events near me?",
        answer:
          "Use the Events page to browse upcoming events. You can filter by date, location, and event type to find fairs and festivals in your area.",
      },
      {
        question: "Can I save events I'm interested in?",
        answer:
          "Yes! Sign in to your account and click the heart icon on any event, venue, or vendor to add it to your favorites. Access your favorites from your dashboard.",
      },
      {
        question: "How do I know which vendors will be at an event?",
        answer:
          "Each event page shows the list of approved vendors. You can browse vendor profiles to see their products, photos, and contact information before the event.",
      },
      {
        question: "Can I get notified about new events?",
        answer:
          "While we don't currently offer email notifications, you can check back regularly or follow your favorite promoters and venues to stay updated on their upcoming events.",
      },
    ],
  },
  {
    title: "For Vendors",
    icon: Store,
    iconBg: "bg-purple-100",
    iconColor: "text-purple-600",
    items: [
      {
        question: "How do I create a vendor profile?",
        answer:
          "Sign in to your account and navigate to the Vendor section. You can create a profile with your business name, description, photos, product categories, and contact information.",
      },
      {
        question: "How do I apply to participate in an event?",
        answer:
          "Browse events and look for the 'Apply' button on event pages that are accepting vendor applications. Submit your application and the event promoter will review it.",
      },
      {
        question: "How long does it take to get approved for an event?",
        answer:
          "Approval times vary by event and promoter. Most promoters review applications within a few days to a week. You'll be notified when your application status changes.",
      },
      {
        question: "Are there fees to participate as a vendor?",
        answer:
          "Booth fees and participation costs are set by individual event promoters. Check each event's details for information about vendor fees, booth sizes, and requirements.",
      },
      {
        question: "Can I apply to multiple events at once?",
        answer:
          "Yes, you can apply to as many events as you'd like. Each application is reviewed independently by the respective event promoter.",
      },
    ],
  },
  {
    title: "For Promoters",
    icon: Calendar,
    iconBg: "bg-orange-100",
    iconColor: "text-orange-600",
    items: [
      {
        question: "How do I list my event?",
        answer:
          "Create a promoter account and use the event submission form to add your fair, festival, or market. Include details like dates, location, vendor categories, and application deadlines.",
      },
      {
        question: "Is it free to list events?",
        answer:
          "Basic event listings are free. Contact us for information about featured listings and promotional opportunities that can increase your event's visibility.",
      },
      {
        question: "How do I manage vendor applications?",
        answer:
          "From your promoter dashboard, you can view all applications for your events, approve or decline vendors, and communicate with applicants.",
      },
      {
        question: "Can I edit my event after it's published?",
        answer:
          "Yes, you can update event details, dates, and vendor information at any time from your promoter dashboard. Changes are reflected immediately on the public listing.",
      },
      {
        question: "How do I feature my event for more visibility?",
        answer:
          "Contact us at partnerships@meetmeatthefair.com for information about featured listings and promotional opportunities.",
      },
    ],
  },
  {
    title: "General",
    icon: Settings,
    iconBg: "bg-gray-100",
    iconColor: "text-gray-600",
    items: [
      {
        question: "How do I report an issue with an event listing?",
        answer:
          "If you notice incorrect information or have concerns about a listing, please email us at support@meetmeatthefair.com with details about the issue.",
      },
      {
        question: "How can I contact Meet Me at the Fair?",
        answer:
          "Visit our Contact page for all contact options. For general inquiries, email hello@meetmeatthefair.com. For support issues, email support@meetmeatthefair.com.",
      },
      {
        question: "Is my personal information secure?",
        answer:
          "Yes, we take data security seriously. We use industry-standard encryption and security practices to protect your personal information. See our Privacy Policy for details.",
      },
      {
        question: "Can I suggest a feature or improvement?",
        answer:
          "Absolutely! We love hearing from our users. Send your suggestions to hello@meetmeatthefair.com and we'll consider them for future updates.",
      },
    ],
  },
];

// Flatten all FAQ items for the schema
const allFaqItems = faqCategories.flatMap((category) => category.items);

export default function FAQPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <FAQSchema items={allFaqItems} />

      {/* Hero Section */}
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Frequently Asked Questions
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          Find answers to common questions about using Meet Me at the Fair
        </p>
      </div>

      {/* FAQ Categories */}
      <div className="space-y-10">
        {faqCategories.map((category) => (
          <section key={category.title}>
            <div className="flex items-center gap-3 mb-6">
              <div
                className={`w-10 h-10 ${category.iconBg} rounded-lg flex items-center justify-center`}
              >
                <category.icon
                  className={`w-5 h-5 ${category.iconColor}`}
                  aria-hidden="true"
                />
              </div>
              <h2 className="text-2xl font-semibold text-gray-900">
                {category.title}
              </h2>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 px-6">
              <Accordion type="single">
                {category.items.map((item, index) => (
                  <AccordionItem
                    key={`${category.title}-${index}`}
                    value={`${category.title}-${index}`}
                  >
                    <AccordionTrigger className="text-base">
                      {item.question}
                    </AccordionTrigger>
                    <AccordionContent>{item.answer}</AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </section>
        ))}
      </div>

      {/* CTA Section */}
      <div className="bg-gray-50 rounded-xl p-8 text-center mt-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">
          Still Have Questions?
        </h2>
        <p className="text-gray-600 mb-6">
          Can&apos;t find what you&apos;re looking for? We&apos;re here to help.
        </p>
        <a
          href="/contact"
          className="inline-flex items-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          Contact Us
        </a>
      </div>
    </div>
  );
}
