import Link from "next/link";
import type { Metadata } from "next";
import { CheckCircle2, AlertCircle } from "lucide-react";

export const metadata: Metadata = {
  title: "Newsletter Unsubscribe | Meet Me at the Fair",
  description: "Manage your subscription to the Meet Me at the Fair weekend digest.",
  robots: { index: false, follow: false },
};

interface Props {
  searchParams: Promise<{ status?: string }>;
}

interface StatusCopy {
  icon: typeof CheckCircle2;
  iconClass: string;
  heading: string;
  body: string;
}

const COPY_BY_STATUS: Record<string, StatusCopy> = {
  ok: {
    icon: CheckCircle2,
    iconClass: "text-green-600",
    heading: "You've been unsubscribed",
    body: "You won't receive the weekend digest anymore. Sorry to see you go — you can re-subscribe any time from the footer of any page.",
  },
  invalid: {
    icon: AlertCircle,
    iconClass: "text-red-600",
    heading: "This unsubscribe link isn't valid",
    body: "We couldn't verify this link. It may be incomplete — please open the link straight from the newsletter email, or manage your subscription from any page footer.",
  },
  missing_token: {
    icon: AlertCircle,
    iconClass: "text-red-600",
    heading: "Unsubscribe link is incomplete",
    body: "The link is missing its token. Re-open it from the newsletter email and make sure you copied the full URL.",
  },
  server_error: {
    icon: AlertCircle,
    iconClass: "text-red-600",
    heading: "Something went wrong",
    body: "We hit an unexpected error processing your request. Please try the link again in a minute.",
  },
};

const DEFAULT_COPY: StatusCopy = COPY_BY_STATUS.server_error;

export default async function NewsletterUnsubscribedPage({ searchParams }: Props) {
  const { status } = await searchParams;
  const copy = COPY_BY_STATUS[status ?? ""] ?? DEFAULT_COPY;
  const Icon = copy.icon;

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-16">
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <div className="flex justify-center mb-4">
          <Icon className={`w-12 h-12 ${copy.iconClass}`} aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-3">{copy.heading}</h1>
        <p className="text-muted-foreground mb-8">{copy.body}</p>
        <Link
          href="/"
          className="inline-flex items-center px-5 py-2.5 bg-secondary text-secondary-foreground font-medium rounded-lg hover:bg-secondary/90 transition-colors"
        >
          Back to Meet Me at the Fair
        </Link>
      </div>
    </div>
  );
}
