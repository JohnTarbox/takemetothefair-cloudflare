import Link from "next/link";
import type { Metadata } from "next";
import { CheckCircle2, AlertCircle, Clock } from "lucide-react";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Newsletter Confirmation | Meet Me at the Fair",
  description: "Confirm your subscription to the Meet Me at the Fair weekend digest.",
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
    heading: "You're confirmed",
    body: "Thanks for confirming. You'll get our weekend digest of New England events, new vendors, and hidden gems in your inbox every Friday.",
  },
  already_confirmed: {
    icon: CheckCircle2,
    iconClass: "text-green-600",
    heading: "You're already subscribed",
    body: "Your subscription is already active. There's nothing more to do — the next digest is on its way.",
  },
  expired: {
    icon: Clock,
    iconClass: "text-yellow-600",
    heading: "This link has expired",
    body: "Confirmation links are valid for 24 hours. Submit your email again on any page footer to get a fresh confirmation email.",
  },
  not_found: {
    icon: AlertCircle,
    iconClass: "text-red-600",
    heading: "This link is no longer valid",
    body: "We couldn't match this confirmation link to a pending subscription. It may have been used already, or the email address was removed. Re-subscribe from any page footer.",
  },
  missing_token: {
    icon: AlertCircle,
    iconClass: "text-red-600",
    heading: "Confirmation link is incomplete",
    body: "The link is missing its confirmation token. Re-open the link from your confirmation email — make sure you copied the full URL.",
  },
  server_error: {
    icon: AlertCircle,
    iconClass: "text-red-600",
    heading: "Something went wrong",
    body: "We hit an unexpected error confirming your subscription. Try the link again in a minute, or re-submit your email if the problem persists.",
  },
};

const DEFAULT_COPY: StatusCopy = COPY_BY_STATUS.server_error;

export default async function NewsletterConfirmedPage({ searchParams }: Props) {
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
