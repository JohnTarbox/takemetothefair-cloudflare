import { Quote } from "lucide-react";

interface Props {
  quote: string;
  author: string;
  role: string;
  location?: string;
}

/**
 * Featured-testimonial card. Hard-coded seed content for now; swap to a
 * CMS-driven list once there are enough testimonials to rotate.
 */
export function Testimonial({ quote, author, role, location }: Props) {
  return (
    <figure className="rounded-xl border border-stone-100 bg-stone-50 p-6 md:p-8">
      <Quote className="w-8 h-8 text-terracotta mb-3" aria-hidden />
      <blockquote className="text-lg md:text-xl text-stone-900 leading-relaxed italic">
        &ldquo;{quote}&rdquo;
      </blockquote>
      <figcaption className="mt-4 text-sm text-stone-600">
        <strong className="font-semibold text-stone-900 not-italic">{author}</strong> · {role}
        {location ? <> · {location}</> : null}
      </figcaption>
    </figure>
  );
}
